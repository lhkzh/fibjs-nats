"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// copy from https://www.npmjs.com/package/nuid
let crypto = require("crypto");
const VERSION = '1.0.0', digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', base = 36, preLen = 12, seqLen = 10, maxSeq = 3656158440062976, // base^seqLen == 36^10
minInc = 33, maxInc = 333, totalLen = preLen + seqLen;
exports.version = VERSION;
class Nuid {
    constructor() {
        this.next = function () {
            this.seq += this.inc;
            if (this.seq > maxSeq) {
                this.setPre();
                this.initSeqAndInc();
            }
            this.fillSeq();
            return (this.buf.toString('ascii'));
        };
        this.buf = Buffer.alloc(totalLen);
        this.init();
    }
    init() {
        this.setPre();
        this.initSeqAndInc();
        this.fillSeq();
    }
    initSeqAndInc() {
        this.seq = Math.floor(Math.random() * maxSeq);
        this.inc = Math.floor((Math.random() * (maxInc - minInc)) + minInc);
    }
    setPre() {
        const cbuf = crypto.randomBytes(preLen);
        for (let i = 0; i < preLen; i++) {
            const di = cbuf[i] % base;
            this.buf[i] = digits.charCodeAt(di);
        }
    }
    fillSeq() {
        let n = this.seq;
        for (let i = totalLen - 1; i >= preLen; i--) {
            this.buf[i] = digits.charCodeAt(n % base);
            n = Math.floor(n / base);
        }
    }
}
const g = new Nuid();
function next() {
    return g.next();
}
exports.next = next;
function reset() {
    g.init();
}
exports.reset = reset;
