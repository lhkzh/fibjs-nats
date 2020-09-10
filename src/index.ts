/// <reference types="@fibjs/types" />
import util = require('util');
import events = require('events');
import net = require('net');
import io = require('io');
import coroutine = require('coroutine');
import URL = require("url");
import nuid = require("./Nuid");

/**
 * nats客户端实现。支持的地址实现（"nats://127.0.0.1:4222", "nats://user:pwd@127.0.0.1:4223", "nats://token@127.0.0.1:4234"）
 * 协议参考
 * https://www.cnblogs.com/liang1101/p/6641348.html
 * https://github.com/repejota/phpnats
 */
export class Nats extends events.EventEmitter {
    private subscriptions: { [index: string]: { subject: string, sid: string, fn: (data: any, meta?: { subject: any, sid: string, reply?: (replyData: any) => void }) => void, num: number, t?: Class_Timer } } = {}
    private address_list: Array<NatsAddress> = [];
    private default_server: NatsAddress = {host: "127.0.0.1", port: 4222};
    private sock: Class_Socket;
    private stream: Class_BufferedStream;
    private serverInfo: NatsServerInfo;
    private autoReconnect: boolean;
    private re_connet_ing: Class_Event;
    private pingBacks: Array<(suc: boolean) => void> = [];
    //name=客户端连接名字, noEcho=是否关闭连接自己发出去的消息-回显订阅
    public connectOption: { name?: string, noEcho?: boolean } = {};

    constructor() {
        super();
    }

    public getInfo() {
        return this.serverInfo;
    }

    private toAddr(addr: string | NatsAddress) {
        if (!util.isString(addr)) {
            return <NatsAddress>addr;
        }
        let info = URL.parse(String(addr));
        let itf: NatsAddress = {host: info.hostname, port: info.port.length > 0 ? parseInt(info.port) : 4222};
        if (info.username.length > 0) {
            if (info.password == null || info.password.length < 1) {
                itf.auth_token = info.auth;
            } else {
                itf.user = info.username;
                itf.pass = info.password;
            }
        }
        return itf;
    }

    //构建一个-并主动链接
    public static make(cfg?: { json?: boolean, msgpack?: boolean, name?: string, noEcho?: boolean, url?: string | NatsAddress, urls?: string[] | NatsAddress[] }) {
        let imp: Nats;
        if (cfg) {
            if (cfg.json) {
                imp = new NatsJson();
            } else if (cfg.msgpack) {
                imp = new NatsMsgpack();
            } else {
                imp = new Nats();
            }
            if (cfg.url) {
                imp.addServer(cfg.url);
            }
            if (cfg.urls) {
                cfg.urls.forEach(u => {
                    imp.addServer(u);
                });
            }
            if (cfg.name) {
                imp.connectOption.name = cfg.name;
            }
            if (cfg.noEcho) {
                imp.connectOption.noEcho = cfg.noEcho;
            }
        } else {
            imp = new Nats();
        }
        return imp.connect(2);
    }

    /**
     * 配置连接地址
     * @param addr  ["nats://127.0.0.1:4222", "nats://user:pwd@127.0.0.1:4223", "nats://token@127.0.0.1:4234"]
     */
    public setServer(addr: Array<string> | string) {
        // this.address_list= util.isArray(addr)?<Array<NatsAddress>>addr:[<NatsAddress>addr];
        this.address_list = [];
        (util.isArray(addr) ? <Array<string>>addr : [String(addr)]).forEach(e => {
            this.address_list.push(this.toAddr(e));
        });
        return this;
    }

    //添加服务地址
    public addServer(addr: string | NatsAddress) {
        let itf = this.toAddr(addr);
        let target = JSON.stringify(itf);
        let had = this.address_list.some(e => {
            return JSON.stringify(e) == target;
        });
        if (had) {
            return;
        }
        this.address_list.push(itf);
        return this;
    }

    //移除一个节点服务
    public removeServer(addr: string) {
        let itf = this.toAddr(addr);
        this.address_list = this.address_list.filter(e => {
            return e.host == itf.host && e.port == itf.port;
        });
        if (this.serverInfo && this.serverInfo.host == itf.host && this.serverInfo.port == itf.port) {
            this.close();
            this.reconnect();
        }
        return true;
    }

    //重连
    public reconnect() {
        let evt = this.re_connet_ing;
        if (evt) {
            let fail_err = new Error();
            evt.wait();
            if (evt["_err_"]) {
                fail_err.message = evt["_err_"].message;
                throw fail_err;
            }
            return;
        }
        try {
            evt = this.re_connet_ing = new coroutine.Event();
            this.connect(8181, 50, this.autoReconnect);
            this.re_connet_ing = null;
            evt.set();
        } catch (e) {
            this.re_connet_ing = null;
            evt["_err_"] = e;
            evt.set();
            throw e;
        }
    }

    /**
     * 建立连接
     * @param retryNum
     * @param retryDelay
     * @param autoReconnect
     */
    public connect(retryNum: number = 3, retryDelay: number = 60, autoReconnect: boolean = true) {
        let last = this.sock;
        if (last != null) {
            try {
                last.close();
            } catch (e) {
            }
            this.sock = null;
            this.stream = null;
            this.serverInfo = null;
        }
        this.autoReconnect = autoReconnect;
        let tmps = this.address_list && this.address_list.length > 0 ? this.address_list.slice(0) : [this.default_server];
        tmps = shuffle(tmps);
        M:for (let i = 0; i < Math.max(1, retryNum * tmps.length); i++) {
            for (let j = 0; j < tmps.length; j++) {
                let node = tmps[j], fail_at = "open_sock", sock = new net.Socket(), stream: Class_BufferedStream;
                try {
                    sock.connect(node.host, node.port);
                    stream = new io.BufferedStream(sock);
                    stream.EOL = "\r\n";
                    let info = stream.readLine(360);
                    if (info == null) {
                        continue;
                    }
                    let opt: any = {
                        verbose: false,
                        pedantic: false,
                        ssl_required: false,
                        name: this.connectOption.name || "fibjs-nats",
                        lang: "fibjs",
                        version: "1.0.0"
                    }
                    if (this.connectOption.noEcho) {
                        opt.echo = false;
                    }
                    if (node.user && node.pass) {
                        opt.user = node.user;
                        opt.pass = node.pass;
                    } else if (node.auth_token) {
                        opt.auth_token = node.auth_token;
                    }
                    fail_at = "auth_connect";
                    sock.send(Buffer.from(`CONNECT ${JSON.stringify(opt)}\r\n`));
                    sock.send(B_PING_EOL);
                    if (stream.readLine(8) != null) {
                        this.sock = sock;
                        this.stream = stream;
                        this.serverInfo = JSON.parse(info.toString().split(" ")[1]);
                        break M;
                    } else {
                        sock.close();
                    }
                } catch (e) {
                    sock.close();
                    console.error('Nats|open_fail', node.host + ':' + node.port, fail_at);
                }
            }
            if (retryDelay > 0) {
                coroutine.sleep(retryDelay);
            }
        }
        if (this.sock == null) {
            this.emit("error", "connect_nats_fail", JSON.stringify(this.address_list));
            let err = new Error("connect_nats_fail");
            console.log("nats|connect", err.message)
            throw err;
        }
        coroutine.start(this.read2pass.bind(this));
        coroutine.sleep();
        return this;
    }

    /**
     * 检测是否能连通
     */
    public ping(): boolean {
        if (!this.sock) {
            return false;
        }
        try {
            this.send(B_PING_EOL);
            let evt = new coroutine.Event(false),
                ret: boolean;
            this.pingBacks.push(suc => {
                ret = suc;
                evt.set();
            });
            evt.wait();
            return ret;
        } catch (e) {
            return false;
        }
    }

    /**
     * 请求接口
     * @param subject
     * @param payload
     */
    public request(subject: string, payload: any, timeoutTtl: number = 3000): Promise<any> {
        let self = this, sid, subs = self.subscriptions, timeout;
        return new Promise<any>((resolve, reject) => {
            try {
                var inbox = '_INBOX.' + nuid.next();
                sid = self.subscribe(inbox, d => {
                    resolve(d);
                }, 1);
                var part = subs[sid];
                timeout = part.t = setTimeout(() => {
                    delete subs[sid];
                    reject(new Error("nats_req_timeout:" + subject));
                    self.unsubscribe(inbox);
                }, timeoutTtl);
                self.publish(subject, payload, inbox);
            } catch (e) {
                if (sid) {
                    delete subs[sid];
                    if (timeout) {
                        clearTimeout(timeout);
                    }
                }
                reject(e);
            }
        });
    }

    /**
     * 同步-请求接口
     * @param subject
     * @param payload
     */
    public requestSync(subject: string, payload: any, timeoutTtl: number = 3000): any {
        let self = this,
            subs = this.subscriptions,
            inbox = '_INBOX.' + nuid.next(),
            evt = new coroutine.Event(false),
            isTimeouted, timeout: Class_Timer, sid: string, rsp: any
        ;

        try {
            sid = this.subscribe(inbox, function (d) {
                rsp = d;
                evt.set();
            }, 1);
            timeout = subs[sid].t = setTimeout(function () {
                isTimeouted = true;
                delete subs[sid];
                evt.set();
                try {
                    self.unsubscribe(inbox);
                } catch (e) {
                }
            }, timeoutTtl);
            this.publish(subject, payload, inbox);
        } catch (e) {
            if (sid) {
                delete subs[sid];
                if (timeout) {
                    clearTimeout(timeout);
                    try {
                        this.unsubscribe(inbox);
                    } catch (e) {
                    }
                }
            }
            throw e;
        }
        evt.wait();
        delete subs[sid];
        clearTimeout(timeout);
        if (isTimeouted) {
            throw new Error("nats_req_timeout_" + subject);
        }
        return rsp;
    }

    /**
     * 抢占式(queue)侦听主题
     * @param subject
     * @param queue
     * @param callBack
     * @param limit
     */
    public queueSubscribe(subject: string, queue: string, callBack: (data: any, meta?: { subject: any, sid: string, reply?: (replyData: any) => void }) => void, limit?: number): string {
        return this.subscribe(subject + ' ' + queue, callBack, limit);
    }

    /**
     * 订阅主题
     * @param subject 主题
     * @param callBack 回调函数
     * @param limit 限制执行次数，默认无限次
     * @returns 订阅的编号
     */
    public subscribe(subject: string, callBack: (data: any, meta?: { subject: any, sid: string, reply?: (replyData: any) => void }) => void, limit?: number): string {
        let sid = nuid.next();
        this.subscriptions[sid] = {
            subject: subject,
            sid: sid,
            fn: callBack,
            num: limit > 0 ? limit : -1
        };
        this.send(Buffer.from(`SUB ${subject} ${sid}\r\n`));
        return sid;
    }

    /**
     * 取消订阅
     * @param sid 订阅编号
     * @param quantity
     */
    public unsubscribe(sid: string, quantity?: number) {
        let msg = arguments.length > 1 ? `UNSUB ${sid} ${quantity}\r\n` : `UNSUB ${sid}\r\n`;
        this.send(Buffer.from(msg));
        if (arguments.length < 2) {
            delete this.subscriptions[sid];
        }
    }

    /**
     * 取消目标主题的订阅
     * @param subject 主题
     */
    public unsubscribeSubject(subject: string) {
        Object.values(this.subscriptions).forEach(e => {
            if (e.subject == subject) {
                this.unsubscribe(e.sid);
            }
        });
    }

    /**
     * 取消所有订阅
     */
    public unsubscribeAll() {
        let vals = Object.values(this.subscriptions);
        this.subscriptions = {};
        if (!this.sock) {
            return;
        }
        vals.forEach(e => {
            try {
                this.unsubscribe(e.sid);
            } catch (e) {
            }
        });
    }

    /**
     * 关闭链接
     */
    public close() {
        let last = this.autoReconnect;
        this.autoReconnect = false;
        if (this.sock) {
            this.sock.close();
        }
        coroutine.sleep();
        this.autoReconnect = last;
    }

    /**
     * 发布数据
     * @param subject 主题
     * @param payload 数据
     * @param inbox 队列标记
     */
    public publish(subject: string, payload?: any, inbox?: string) {
        let arr: Array<any> = [B_PUB, Buffer.from(subject)];
        if (inbox) {
            arr.push(B_SPACE, Buffer.from(inbox));
        }
        if (payload != null) {
            let pb: Class_Buffer = this.encode(payload);
            arr.push(Buffer.from(` ${pb.length}\r\n`), pb, B_EOL);
        } else {
            arr.push(B_PUBLISH_EMPTY)
        }
        this.send(Buffer.concat(arr));
    }

    protected send(payload) {
        try {
            this.sock.send(payload);
        } catch (e) {
            this.on_lost();
            if (this.autoReconnect) {
                if (!this.sock) this.reconnect();
                this.sock.send(payload);
            } else {
                throw e;
            }
        }
    }

    protected process_msg(subject: string, sid: string, payload: Class_Buffer, inbox: string) {
        let sop = this.subscriptions[sid];
        try {
            let data = payload.length > 0 ? this.decode(payload) : null;
            if (sop) {
                var meta: { subject: any, sid: string, reply?: (replyData: any) => void } = {
                    subject: subject,
                    sid: sid
                };
                if (inbox) {
                    meta.reply = (replyData) => {
                        this.publish(inbox, replyData);
                    };
                }
                if (sop.num > 1) {
                    sop.num--;
                    if (sop.num == 0) {
                        delete this.subscriptions[sid];
                        if (sop.t) {
                            clearTimeout(sop.t);
                        }
                    }
                }
                sop.fn(data, meta);
            } else if (inbox) {//队列选了当前执行节点，但是当前节点给取消订阅了
                this.publish(subject, payload, inbox);
            }
            this.emit(subject, data);
        } catch (e) {
            console.error("nats|process", e);
        }
    }

    private read2pass() {
        const sock = this.sock;
        const stream = this.stream;
        const processMsg = this.process_msg.bind(this);
        const processPong = this.process_pong.bind(this);
        try {
            Object.values(this.subscriptions).forEach(e => {
                sock.send(Buffer.from(`SUB ${e.subject} ${e.sid}\r\n`));
            });
        } catch (e) {
        }
        while (sock == this.sock) {
            try {
                let line = stream.readLine();
                if (this.is_read_fail(line)) {
                    // console.log("read_fail:0",line,data);
                    break;
                }
                if (line == S_PING) {
                    this.send(B_PONG_EOL);
                    continue;
                } else if (line == S_PONG) {
                    coroutine.start(processPong, true);
                    continue;
                } else if (line == S_OK) {
                    continue;
                }
                //MSG subject sid size
                let arr = line.split(" ");
                let subject = arr[1];
                let sid = arr[2];
                let inbox = arr.length > 4 ? arr[3] : null;
                let len = arr.length > 4 ? Number(arr[4]) : Number(arr[3]);
                // console.log(line, len);
                if (len == 0) {
                    coroutine.start(processMsg, subject, sid, EMPTY_BUF, inbox);
                    continue;
                }
                let data = stream.read(len);
                // console.log(data, String(data))
                if (this.is_read_fail(data)) {
                    // console.log("read_fail:1",line,data);
                    break;
                }
                stream.read(2);
                coroutine.start(processMsg, subject, sid, data, inbox);
            } catch (e) {
                console.error("nats|read2pass", e);
                break;
            }
        }
    }

    private is_read_fail(d) {
        if (d == null) {
            this.on_lost();
            return true;
        }
        return false;
    }

    private on_lost() {
        if (this.sock != null) {
            try {
                this.sock.close();
            } catch (e) {
            }
        }
        this.sock = null;
        console.error("nats|on_lost => %s", JSON.stringify(this.serverInfo));
        this.emit("lost");
        if (this.autoReconnect) {
            coroutine.start(this.reconnect.bind(this));
        }
        this.process_pong(false);
    }

    protected process_pong(ret: boolean) {
        if (this.pingBacks.length > 0) {
            var a = this.pingBacks.concat();
            this.pingBacks.length = 0;
            try {
                a.forEach(f => {
                    f(ret);
                });
            } catch (e) {
                console.error("nats|process_pong", e)
            }
        }
    }

    protected encode(payload: any): Class_Buffer {
        if (util.isBuffer(payload)) {
            return payload;
        }
        return Buffer.from(String(payload));
    }

    protected decode(data: Class_Buffer): any {
        return data;
    }
}

export class NatsJson extends Nats {
    protected encode(payload: any): Class_Buffer {
        var pb: Class_Buffer;
        if (util.isBuffer(payload)) {
            pb = <Class_Buffer>payload;
            pb.writeUInt8(0);
        } else {
            pb = Buffer.from(JSON.stringify(payload));
        }
        return pb;
    }

    protected decode(data: Class_Buffer): any {
        if (data.readUInt8(data.length - 1) == 0) {
            return data.slice(0, data.length - 1);
        }
        return JSON.parse(data.toString());
    }
}

export class NatsMsgpack extends Nats {
    protected encode(payload: any): Class_Buffer {
        return require('msgpack').encode(payload);
    }

    protected decode(data: Class_Buffer): any {
        try {
            return require('msgpack').decode(data);
        } catch (e) {
            console.error("nats|msgpack_decode_err", e.message);
            return data.toString();
        }
    }
}

const EMPTY_BUF = new Buffer([]);
const B_SPACE = Buffer.from(" ");
const B_EOL = Buffer.from("\r\n");
const B_PUB = Buffer.from("PUB ");
const B_PUBLISH_EMPTY = Buffer.from(" 0\r\n\r\n");
const B_PING = Buffer.from("PING");
const B_PING_EOL = Buffer.from("PING\r\n");
const B_PONG = Buffer.from("PONG");
const B_PONG_EOL = Buffer.from("PONG\r\n");
const B_OK = Buffer.from("+OK");
const B_ERR = Buffer.from("-ERR");

const S_PING = "PING";
const S_PING_EOL = Buffer.from("PING\r\n");
const S_PONG = "PONG";
const S_PONG_EOL = "PONG\r\n";
const S_OK = "+OK";

//{"server_id":"NDKOPUBNP4IRWW2UGWBNJ2VNNCWNBO3BTJXBDJ7JIA77ZVENDQF6U7QC","version":"2.0.4","proto":1,"git_commit":"c8ca58e","go":"go1.12.8","host":"0.0.0.0","port":4222,"max_payload":1048576,"cli
// ent_id":20}
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
    auth_token?: string
}

/**
 * @hidden
 */
function shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}