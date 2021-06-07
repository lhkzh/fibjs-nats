# fibjs-nats
nats-client nats客户端实现  

 * 协议参考（暂不支持ssl&jwt,msgpack需要fibjsv0.30+）
 * https://www.cnblogs.com/liang1101/p/6641348.html
 * https://github.com/repejota/phpnats
 * https://github.com/lhkzh/fibjs-nats  
 
 使用  
<pre>
<code>
 const Nats = require("fibjs-nats").Nats;  
 //无授权认证方式
 var nc = Nats.make({json:true,url:"nats://127.0.0.1:4222"});  
 //通过-username:password认证
 var nc_auth_userpassword = Nats.make({json:true,url:"nats://myusername:mypassword@127.0.0.1:4222"});  
 //通过-authtoken认证
 var nc_auth_token = Nats.make({json:true,url:"nats://mytoken@127.0.0.1:4222"});  
  
 nc.subscribe("svr.sum",function (data,meta) {  
     meta.reply(data.a+data.b);  
 });      
 console.log(nc.requestSync("svr.sum",{a:2,b:3})==5)      
 
 nc.subscribe("svr.log",function (data,meta) {  
     console.log("svr.log",data);
 });  
 nc.publish("svr.log", "on xxx");    
 console.log(nc.ping())
</code>
</pre> 

 
 