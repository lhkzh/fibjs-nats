/// <reference types="@fibjs/types" />
import * as events from "events";
/**
 * nats客户端实现。支持的地址实现（"nats://127.0.0.1:4222", "nats://user:pwd@127.0.0.1:4223", "nats://token@127.0.0.1:4234"）
 * 协议参考
 * https://www.cnblogs.com/liang1101/p/6641348.html
 * https://github.com/repejota/phpnats
 */
export declare class Nats extends events.EventEmitter {
    private subscriptions;
    private address_list;
    private default_server;
    private sock;
    private send_lock;
    private stream;
    private serverInfo;
    private autoReconnect;
    private re_connet_ing;
    private pingBacks;
    connectOption: {
        name?: string;
        noEcho?: boolean;
    };
    constructor();
    getInfo(): NatsServerInfo;
    private toAddr;
    static make(cfg?: {
        json?: boolean;
        msgpack?: boolean;
        name?: string;
        noEcho?: boolean;
        url?: string | NatsAddress;
        urls?: string[] | NatsAddress[];
    }, retryConnectNum?: number): Nats;
    /**
     * 配置连接地址
     * @param addr  ["nats://127.0.0.1:4222", "nats://user:pwd@127.0.0.1:4223", "nats://token@127.0.0.1:4234"]
     */
    setServer(addr: Array<string> | string): this;
    addServer(addr: string | NatsAddress): this;
    removeServer(addr: string): boolean;
    reconnect(sucBack?: () => void): void;
    /**
     * 建立连接
     * @param retryNum
     * @param retryDelay
     * @param autoReconnect
     */
    connect(retryNum?: number, retryDelay?: number, autoReconnect?: boolean): this;
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
    queueSubscribe(subject: string, queue: string, callBack: (data: any, meta?: {
        subject: any;
        sid: string;
        reply?: (replyData: any) => void;
    }) => void, limit?: number): string;
    /**
     * 订阅主题
     * @param subject 主题
     * @param callBack 回调函数
     * @param limit 限制执行次数，默认无限次
     * @returns 订阅的编号
     */
    subscribe(subject: string, callBack: (data: any, meta?: {
        subject: any;
        sid: string;
        reply?: (replyData: any) => void;
    }) => void, limit?: number): string;
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
    protected send(payload: any): void;
    protected process_msg(subject: string, sid: string, payload: Class_Buffer, inbox: string): void;
    private read2pass;
    private is_read_fail;
    private on_lost;
    protected process_pong(ret: boolean): void;
    protected encode(payload: any): Class_Buffer;
    protected decode(data: Class_Buffer): any;
}
export declare class NatsJson extends Nats {
    protected encode(payload: any): Class_Buffer;
    protected decode(data: Class_Buffer): any;
}
export declare class NatsMsgpack extends Nats {
    protected encode(payload: any): Class_Buffer;
    protected decode(data: Class_Buffer): any;
}
export interface NatsServerInfo {
    server_id: string;
    version: string;
    go: string;
    max_payload: number;
    client_id: number;
    host: string;
    port: number;
}
export interface NatsAddress {
    host: string;
    port: number;
    user?: string;
    pass?: string;
    auth_token?: string;
}
