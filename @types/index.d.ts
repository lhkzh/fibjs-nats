/// <reference types="@fibjs/types" />
import * as events from "events";
export declare const VERSION = "1.2.7";
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
    private _reConnetIng;
    private _subs;
    private _responses;
    private _pingBacks;
    private _tops;
    private _tops_x;
    private _bakIngNum;
    private _waitToSendNum;
    private _mainInbox;
    private _mainInbox_pre;
    private _nextSid;
    constructor();
    /**
     * 开启快速检测-(isSubscribeSubject,countSubscribeSubject)
     */
    fastCheck(): this;
    /**
     * 当前链接的服务器地址
     */
    get address(): NatsAddress;
    /**
     * 当前链接的服务器的信息
     */
    get info(): NatsServerInfo;
    /**
     * 用于分析当前链接状态
     */
    toStatJson(): {
        ok: boolean;
        repair: boolean;
        pingIngNum: number;
        subNum: number;
        topicNum: number;
        bakNum: number;
        waitToSendNum: number;
    };
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
    private _on_mainInbox;
    /**
     * 检测是否能连通
     */
    pingAsync(): Promise<boolean>;
    /**
     * 请求接口
     * @param subject
     * @param payload
     */
    requestAsync(subject: string, payload: any, timeoutTtl?: number): Promise<any>;
    /**
     * 同步-请求接口
     * @param subject
     * @param payload
     */
    request(subject: string, payload: any, timeoutTtl?: number): any;
    /**
     * 抢占式(queue)侦听主题
     * @param subject
     * @param queue
     * @param callBack
     * @param limit
     */
    queueSubscribe(subject: string, queue: string, callBack: SubFn, limit?: number): NatsSub;
    /**
     * 订阅主题
     * @param subject 主题
     * @param callBack 回调函数
     * @param limit 限制执行次数，默认无限次
     * @returns 订阅的编号
     */
    subscribe(subject: string, callBack: SubFn, limit?: number): NatsSub;
    private _pre_sub_mainInbox;
    private _pre_sub_local_first;
    private _unsubscribe_fast;
    private _unsubscribe_fast_mult;
    private _subject_incr;
    private _subject_decr;
    private _subject_x;
    /**
     * 取消订阅
     * @param sub 订阅编号
     * @param after
     */
    unsubscribe(sub: string | NatsSub, after?: number): void;
    /**
     * 取消目标主题的订阅
     * @param subject 主题
     */
    unsubscribeSubject(subject: string): void;
    /**
     * 取消订阅
     * @param subs 订阅编号
     * @param quantity
     */
    unsubscribeMult(subs: string[] | NatsSub[] | Set<string> | Set<NatsSub>): void;
    /**
     * 检测-是否订阅过目标主题
     * @param subject
     */
    isSubscribeSubject(subject: string): boolean;
    /**
     * 检测-订阅的目标主题的数量
     * @param subject
     */
    countSubscribeSubject(subject: string): number;
    /**
     * 取消所有订阅
     */
    unsubscribeAll(): void;
    /**
     * 关闭链接
     */
    close(): void;
    private _close;
    /**
     * 发布数据
     * @param subject 主题
     * @param payload 数据
     */
    publish(subject: string, payload?: any): void;
    publishInbox(subject: string, inbox: string, payload: any): void;
    private _pub_blob_1;
    private _pub_blob_2;
    private _pub_blob_3;
    protected _send(payload: any, retryWhenReconnect: boolean): void;
    protected _on_msg(subject: string, sid: string, payload: Class_Buffer, inbox: string): void;
    private _on_connect;
    private _on_err;
    private _on_ok;
    private _on_lost;
    protected _on_pong(is_lost: boolean): void;
    protected encode(payload: any): Class_Buffer;
    protected decode(data: Class_Buffer): any;
    set serizalize(c: NatsSerizalize);
    get serizalize(): NatsSerizalize;
    static make(cfg?: string | NatsAddress | NatsConnectCfg, tryInitRetryNum?: number): Nats;
}
export declare class NatsEvent {
    static OnConnect: string;
    static OnError: string;
    static OnLost: string;
    static OnReconnectSuc: string;
    static OnReconnectFail: string;
}
declare type SubFn = (data: any, meta?: {
    subject: string;
    sid: string;
    reply?: (replyData: any) => void;
}) => void;
export declare type NatsSub = {
    subject: string;
    sid: string;
    fn: SubFn;
    num?: number;
    queue?: string;
    cancel: () => void;
};
/**
 * 服务器信息描述
 */
export interface NatsServerInfo {
    server_id: string;
    server_name: string;
    version: string;
    proto: number;
    go: string;
    max_payload: number;
    tls_required: boolean;
    tls_verify: boolean;
    host: string;
    port: number;
    client_id: number;
    client_ip: string;
    headers: boolean;
    auth_required?: boolean;
    nonce?: string;
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
    waitToSendLimitMaxFail?: number;
    name?: string;
    noEcho?: boolean;
    verbose?: boolean;
    pedantic?: boolean;
    serizalize?: NatsSerizalize;
    json?: boolean;
    msgpack?: boolean;
    ssl?: {
        name?: string;
        ca?: string;
        cert?: string;
        key?: string;
    };
    authenticator?: (nonce?: string) => {
        nkey?: string;
        sig: string;
        jwt?: string;
        auth_token?: string;
        user?: string;
        pass?: string;
    };
    subjectAsEvent?: boolean;
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
