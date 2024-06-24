import { Emote, PlayerBarn } from "./objects/player";
import { Grid } from "./utils/grid";
import { TeamMode, type ConfigType } from "./config";
import { type GameObject, ObjectRegister } from "./objects/gameObject";
import { GameMap } from "./map";
import { BullletBarn } from "./objects/bullet";
import { Logger } from "./utils/logger";
import * as net from "../../shared/net";
import { DropItemMsg } from "../../shared/msgs/dropItemMsg";
import { EmoteMsg } from "../../shared/msgs/emoteMsg";
import { JoinMsg } from "../../shared/msgs/joinMsg";
import { InputMsg } from "../../shared/msgs/inputMsg";
import { LootBarn } from "./objects/loot";
import { Gas } from "./objects/gas";
import { SpectateMsg } from "../../shared/msgs/spectateMsg";
import { util } from "../../shared/utils/util";
import { ProjectileBarn } from "./objects/projectile";
import { DeadBodyBarn } from "./objects/deadBody";
import { ExplosionBarn } from "./objects/explosion";
import { ObjectType } from "../../shared/utils/objectSerializeFns";
import { SmokeBarn } from "./objects/smoke";
import { AirdropBarn } from "./objects/airdrop";
import { DecalBarn } from "./objects/decal";
import { Group } from "./group";
import { type PlayerContainer } from "./abstractServer";

export class Game {
    started = false;
    stopped = false;
    allowJoin = true;
    over = false;
    startedTime = 0;
    id: number;
    teamMode: TeamMode;
    isTeamMode: boolean;
    config: ConfigType;

    grid: Grid;
    objectRegister: ObjectRegister;

    groups = new Map<string, Group>();

    get aliveCount(): number {
        return this.playerBarn.livingPlayers.length;
    }

    msgsToSend: Array<{ type: number, msg: net.AbstractMsg }> = [];

    playerBarn = new PlayerBarn(this);
    lootBarn = new LootBarn(this);
    deadBodyBarn = new DeadBodyBarn(this);
    decalBarn = new DecalBarn(this);
    projectileBarn = new ProjectileBarn(this);
    bulletBarn = new BullletBarn(this);
    smokeBarn = new SmokeBarn(this);
    airdropBarn = new AirdropBarn(this);

    explosionBarn = new ExplosionBarn(this);

    map: GameMap;
    gas: Gas;

    now!: number;

    tickTimes: number[] = [];

    logger: Logger;

    typeToPool: Record<ObjectType, GameObject[]>;

    constructor(id: number, config: ConfigType) {
        this.id = id;
        this.logger = new Logger(`Game #${this.id}`);
        this.logger.log("Creating");
        const start = Date.now();

        this.config = config;

        this.teamMode = config.teamMode;
        this.isTeamMode = this.teamMode !== TeamMode.Solo;

        this.grid = new Grid(1024, 1024);
        this.objectRegister = new ObjectRegister(this.grid);
        this.map = new GameMap(this);

        this.gas = new Gas(this.map);

        this.allowJoin = true;

        this.typeToPool = {
            [ObjectType.Invalid]: [],
            [ObjectType.LootSpawner]: [],
            [ObjectType.Player]: this.playerBarn.players,
            [ObjectType.Obstacle]: this.map.obstacles,
            [ObjectType.Loot]: this.lootBarn.loots,
            [ObjectType.DeadBody]: this.deadBodyBarn.deadBodies,
            [ObjectType.Building]: this.map.buildings,
            [ObjectType.Structure]: this.map.structures,
            [ObjectType.Decal]: this.decalBarn.decals,
            [ObjectType.Projectile]: this.projectileBarn.projectiles,
            [ObjectType.Smoke]: this.smokeBarn.smokes,
            [ObjectType.Airdrop]: this.airdropBarn.airdrops
        };

        this.logger.log(`Created in ${Date.now() - start} ms`);
    }

    update(): void {
        const now = Date.now();
        if (!this.now) this.now = now;
        const dt = (now - this.now) / 1000;
        this.now = now;

        //
        // Update modules
        //
        this.gas.update(dt);
        this.bulletBarn.update(dt);
        this.lootBarn.update(dt);
        this.projectileBarn.update(dt);
        this.deadBodyBarn.update(dt);
        this.playerBarn.update(dt);
        this.explosionBarn.update();

        // second update:
        // serialize objects and send msgs
        this.objectRegister.serializeObjs();
        this.playerBarn.sendMsgs(dt);

        //
        // reset stuff
        //
        this.playerBarn.flush();
        this.bulletBarn.flush();
        this.objectRegister.flush();
        this.explosionBarn.flush();
        this.gas.flush();
        this.msgsToSend.length = 0;

        // Record performance and start the next tick
        // THIS TICK COUNTER IS WORKING CORRECTLY!
        // It measures the time it takes to calculate a tick, not the time between ticks.
        const tickTime = Date.now() - this.now;
        this.tickTimes.push(tickTime);

        if (this.tickTimes.length >= 200) {
            const mspt = this.tickTimes.reduce((a, b) => a + b) / this.tickTimes.length;

            this.logger.log(`Avg ms/tick: ${mspt.toFixed(2)} | Load: ${((mspt / (1000 / this.config.tps)) * 100).toFixed(1)}%`);
            this.tickTimes = [];
        }
    }

    nextTeam(currentTeam: Group) {
        const aliveTeams = Array.from(this.groups.values()).filter(t => !t.allDeadOrDisconnected);
        const currentTeamIndex = aliveTeams.indexOf(currentTeam);
        const newIndex = (currentTeamIndex + 1) % aliveTeams.length;
        return aliveTeams[newIndex];
    }

    prevTeam(currentTeam: Group) {
        const aliveTeams = Array.from(this.groups.values()).filter(t => !t.allDeadOrDisconnected);
        const currentTeamIndex = aliveTeams.indexOf(currentTeam);
        const newIndex = currentTeamIndex == 0 ? aliveTeams.length - 1 : currentTeamIndex - 1;
        return aliveTeams[newIndex];
    }

    handleMsg(buff: ArrayBuffer | Buffer, socketData: PlayerContainer): void {
        const msgStream = new net.MsgStream(buff);
        const type = msgStream.deserializeMsgType();
        const stream = msgStream.stream;

        const player = socketData.player;

        if (type === net.MsgType.Join && !player) {
            const joinMsg = new JoinMsg();
            joinMsg.deserialize(stream);
            this.playerBarn.addPlayer(socketData, joinMsg);
            return;
        }

        if (!player) {
            socketData.closeSocket();
            return;
        }

        switch (type) {
        case net.MsgType.Input: {
            const inputMsg = new InputMsg();
            inputMsg.deserialize(stream);
            player.handleInput(inputMsg);
            break;
        }
        case net.MsgType.Emote: {
            const emoteMsg = new EmoteMsg();
            emoteMsg.deserialize(stream);

            this.playerBarn.emotes.push(new Emote(
                player.__id,
                emoteMsg.pos,
                emoteMsg.type,
                emoteMsg.isPing
            ));
            break;
        }
        case net.MsgType.DropItem: {
            const dropMsg = new DropItemMsg();
            dropMsg.deserialize(stream);
            player.dropItem(dropMsg);
            break;
        }
        case net.MsgType.Spectate: {
            const spectateMsg = new SpectateMsg();
            spectateMsg.deserialize(stream);
            player.spectate(spectateMsg);
            break;
        }
        }
    }

    checkGameOver(): void {
        if (this.over) return;
        if (!this.isTeamMode) {
            if (this.started && this.aliveCount <= 1) {
                this.initGameOver();
            }
        } else {
            const groupAlives = [...this.groups.values()].filter(group => !group.allDeadOrDisconnected);
            if (groupAlives.length <= 1) {
                this.initGameOver(groupAlives[0]);
            }
        }
    }

    initGameOver(winningGroup?: Group): void {
        if (this.over) return;
        this.over = true;
        if (!this.isTeamMode) {
            const winningPlayer = this.playerBarn.livingPlayers[0];
            if (winningPlayer) {
                winningPlayer.addGameOverMsg(winningPlayer.teamId);
            }
        } else if (winningGroup) {
            for (const player of winningGroup.players) {
                player.addGameOverMsg(winningGroup.groupId);
            }
        }
        setTimeout(() => {
            this.stop();
        }, 750);
    }

    addGroup(id: string) {
        const groupId = this.playerBarn.groupIdAllocator.getNextId();
        let teamId = groupId;
        if (this.map.factionMode) {
            teamId = util.randomInt(1, 2);
        }
        const group = new Group(groupId, teamId);
        this.groups.set(id, group);
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.allowJoin = false;
        for (const player of this.playerBarn.players) {
            if (!player.disconnected) {
                player.closeSocket();
            }
        }
        this.logger.log("Game Ended");
    }
}
