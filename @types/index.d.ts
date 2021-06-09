/// <reference types="@fibjs/types" />
import * as events from "events";
export declare const VERSION = "1.1.0";
export declare const LANG = "fibjs";
/**
 * nats客户端实现。支持的地址实现（"nats://127.0.0.1:4222", "nats://user:pwd@127.0.0.1:4223", "nats://token@127.0.0.1:4234"）
 * 协议参考
 * https://www.cnblogs.com/liang1101/p/6641348.html
 * https://github.com/repejota/phpnats
 */
export declare class Nats extends events.EventEmitter {
    private _serverList;
    private _cfg;
    private _connection;
    private subscriptions;
    private _pingBacks;
    private _okWaits;
    private _reConnetIng;
    constructor();
    get address(): NatsAddress;
    get info(): NatsServerInfo;
    /**
     * 配置连接地址
     * @param addr  ["nats://127.0.0.1:4222", "nats://user:pwd@127.0.0.1:4223", "nats://token@127.0.0.1:4234"]
     */
    setAllServer(addr: Array<string | NatsAddress> | string | NatsAddress): this;
    addServer(addr: string | NatsAddress): this;
    removeServer(addr: string | NatsAddress): this;
    reconnect(): void;
    private _do_connect;
    private _shuffle_server_list;
    /**
     * 建立连接
     * @param retryNum
     * @param retryDelay
     * @param autoReconnect
     */
    connect(): this;
    /**
     * 检测是否能连通
     */
    ping(): boolean;
    /**
     * 请求接口
     * @param subject
     * @param payload
     */
    request(subject: string, payload: any, timeoutTtl?: number): Promise<any>;
    /**
     * 同步-请求接口
     * @param subject
     * @param payload
     */
    requestSync(subject: string, payload: any, timeoutTtl?: number): any;
    /**
     * 抢占式(queue)侦听主题
     * @param subject
     * @param queue
     * @param callBack
     * @param limit
     */
    queueSubscribe(subject: string, queue: string, callBack: SubFn, limit?: number): string;
    /**
     * 订阅主题
     * @param subject 主题
     * @param callBack 回调函数
     * @param limit 限制执行次数，默认无限次
     * @returns 订阅的编号
     */
    subscribe(subject: string, callBack: SubFn, limit?: number): string;
    private _pre_sub_local_first;
    /**
     * 取消订阅
     * @param sid 订阅编号
     * @param quantity
     */
    unsubscribe(sid: string, quantity?: number): void;
    /**
     * 取消目标主题的订阅
     * @param subject 主题
     */
    unsubscribeSubject(subject: string): void;
    /**
     * 取消所有订阅
     */
    unsubscribeAll(): void;
    /**
     * 关闭链接
     */
    close(): void;
    /**
     * 发布数据
     * @param subject 主题
     * @param payload 数据
     * @param inbox 队列标记
     */
    publish(subject: string, payload?: any, inbox?: string): void;
    protected _send(payload: any, retryWhenReconnect: boolean): void;
    protected _on_msg(subject: string, sid: string, payload: Class_Buffer, inbox: string): void;
    private _on_connect;
    private _on_ok;
    private _on_lost;
    protected _on_pong(is_lost: boolean): void;
    protected encode(payload: any): Class_Buffer;
    protected decode(data: Class_Buffer): any;
    static make(cfg?: string | NatsAddress | NatsConnectCfg): Nats;
}
export declare class NatsEvent {
    static OnConnect: string;
    static OnError: string;
    static OnLost: string;
    static OnReconnectSuc: string;
    static OnReconnectFail: string;
}
declare type SubFn = (data: any, meta?: {
    subject: any;
    sid: string;
    reply?: (replyData: any) => void;
}) => void;
/**
 * 服务器信息描述
 */
export interface NatsServerInfo {
    server_id: string;
    version: string;
    go: string;
    max_payload: number;
    client_id: number;
    host: string;
    port: number;
}
/**
 * 服务器地址配置
 */
export interface NatsAddress {
    url?: string;
    user?: string;
    pass?: string;
    token?: string;
}
export interface NatsConfig {
    timeout?: number;
    pingInterval?: number;
    maxPingOut?: number;
    reconnect?: boolean;
    reconnectWait?: number;
    noRandomize?: boolean;
    maxReconnectAttempts?: number;
    name?: string;
    noEcho?: boolean;
    serizalize?: NatsSerizalize;
    json?: boolean;
    msgpack?: boolean;
}
declare type NatsConnectCfg_Mult = NatsConfig & {
    servers?: Array<string | NatsAddress>;
};
declare type NatsConnectCfg_One = NatsConfig & {
    url?: string | NatsAddress;
};
declare type NatsConnectCfg = NatsConnectCfg_Mult | NatsConnectCfg_One;
export declare type NatsSerizalize = {
    encode: (payload: any) => Class_Buffer;
    decode: (buf: Class_Buffer) => any;
};
export declare const NatsSerizalize_Json: NatsSerizalize;
export declare const NatsSerizalize_Msgpack: NatsSerizalize;
export declare const NatsSerizalize_Str: NatsSerizalize;
export declare const NatsSerizalize_Buf: NatsSerizalize;
export {};
