// copy from https://www.npmjs.com/package/nuid
let crypto=require("crypto");
const VERSION  = '1.0.0',
    digits   = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    base     = 36,
    preLen   = 12,
    seqLen   = 10,
    maxSeq   = 3656158440062976, // base^seqLen == 36^10
    minInc   = 33,
    maxInc   = 333,
    totalLen = preLen + seqLen;
exports.version = VERSION;
class Nuid {
    private buf:Class_Buffer;
    private seq:number;
    private inc:number;
    constructor(){
        this.buf = Buffer.alloc(totalLen);
        this.init();
    }
    public init(){
        this.setPre();
        this.initSeqAndInc();
        this.fillSeq();
    }
    private initSeqAndInc(){
        this.seq = Math.floor(Math.random() * maxSeq);
        this.inc = Math.floor((Math.random() * (maxInc - minInc)) + minInc);
    }
    private setPre() {
        const cbuf = crypto.randomBytes(preLen);
        for (let i = 0; i < preLen; i++) {
            this.buf[i] = digits.charCodeAt(cbuf[i] % base);
        }
    }
    private fillSeq() {
        let n = this.seq;
        for (let i = totalLen - 1; i >= preLen; i--) {
            this.buf[i] = digits.charCodeAt(n % base);
            n = Math.floor(n / base);
        }
    }
    public next = function() {
        this.seq += this.inc;
        if (this.seq > maxSeq) {
            this.setPre();
            this.initSeqAndInc();
        }
        this.fillSeq();
        return (this.buf.toString('ascii'));
    }
}

const g = new Nuid();
export function next():string {
    return g.next();
}
export function reset() {
    g.init();
}