/**
 # as ss-local:
 # stage 0 SOCKS hello received from local, send hello to local
 # stage 1 addr received from local, query DNS for remote
 # stage 2 UDP assoc
 # stage 3 DNS resolved, connect to remote
 # stage 4 still connecting, more data from local received
 # stage 5 remote connected, piping local and remote
 # as ss-server:
 # stage 0 just jump to stage 1
 # stage 1 addr received from local, query DNS for remote
 # stage 3 DNS resolved, connect to remote
 # stage 4 still connecting, more data from local received
 # stage 5 remote connected, piping local and remote
 **/
import net from "net";
import {ExpandedConfig} from "./configLib";
import Shadow from "./Shadow";

const configLib = require("./configLib");
const udpRelay = require("./udprelay");
const utils = require("./utils");
// const inet = require("./inet");
const log = require("./log");
// const Encryptor = require("./encrypt").Encryptor;

// 连接总数
// 这是个全局的变量
let connections = 0;

function handlerConnection(config: ExpandedConfig) {
    return function (connection: net.Socket) {
        // 下面的内容是每个local 与 server 建立一次连接 就会初始化一个
        connections++;
        log.debug("connections: " + connections);
        // let encryptor = new Encryptor(config.password, config.method);
        let stage = 0;
        let remote = new net.Socket();

        /**
         * connection on data
         */
        let shadow = new Shadow(config.password, config.method);
        connection.on("data", function (data) {
            log.debug("connection on data");
            let data2: Buffer = Buffer.from(data);
            shadow.onLocalData(data2);
            /////////////
            // try {
            //     data = encryptor.decrypt(data);
            //     console.log("there", data);
            // } catch (e) {
            //     log.error("connection on data error " + e);
            //     if (remote) {
            //         remote.destroy();
            //     }
            //     if (connection) {
            //         connection.destroy();
            //     }
            //     return;
            // }
            ////////////////////
            try {
                if (stage === 0) {
                    connection.pause();
                    ///////////////////////////
                    remote.connect(shadow.remotePort, shadow.remoteAddr, () => {
                        log.info("connect " + shadow.remoteAddr + ":" + shadow.remotePort);
                        if (!connection) {
                            remote.destroy();
                            return;
                        }
                        //好重要
                        if (!remote) {
                            log.error("remote lost");
                            return;
                        }
                        connection.resume();
                        // while (cachedPieces.length) {
                        while (shadow.dataCacheFromLocal.length) {
                            // remote.write(cachedPieces.shift());
                            remote.write(shadow.dataCacheFromLocal.shift());
                        }
                        stage = 5;
                        return log.debug("stage = 5");
                    });

                    // stage = 4;
                    // log.debug("stage = 4");
                    return
                }
                // if (stage === 4) {
                //     cachedPieces.push(data);
                //     shadow.onLocalData(data);
                //     console.log("my stag 4 cache", shadow.dataCacheFromLocal);
                //     console.log("th stag 4 cache", cachedPieces);
                //
                // }
                if (stage === 5) {
                    // if (!remote.write(data)) {
                    if (!remote.write(shadow.dataCacheFromLocal.shift())) {
                        connection.pause();
                    }
                }
            } catch (e) {
                log.error(e.stack);
                if (remote) {
                    remote.destroy();
                }
                if (connection) {
                    connection.destroy();
                }
            }

        });

        remote.on("data", function (data: Buffer) {
            log.debug("remote on data");
            // if (!encryptor) {
            //     if (remote) {
            //         remote.destroy();
            //     }
            //     return;
            // }
            // data = encryptor.encrypt(data);
            shadow.onRemoteData(data);
            while (shadow.dataCacheFromRemote.length) {
                if (!connection.write(shadow.dataCacheFromRemote.shift())) {
                    return remote.pause();
                }
            }
        });
        remote.on("end", function () {
            log.debug("remote on end");
            if (connection) {
                return connection.end();
            }
        });
        remote.on("error", function (e: String) {
            log.debug("remote on error");
            return log.error("remote " + shadow.remoteAddr + ":" + shadow.remotePort + " error: " + e);
        });
        remote.on("close", function (had_error: String) {
            log.debug("remote on close:" + had_error);
            if (had_error) {
                if (connection) {
                    return connection.destroy();
                }
            } else {
                if (connection) {
                    return connection.end();
                }
            }
        });
        remote.on("drain", function () {
            log.debug("remote on drain");
            if (connection) {
                return connection.resume();
            }
        });
        remote.setTimeout(config.timeout, function () {
            log.debug("remote on timeout during connect()");
            if (remote) {
                remote.destroy();
            }
            if (connection) {
                return connection.destroy();
            }
        });
        connection.on("end", function () {
            log.debug("connection on end");
            if (remote) {
                return remote.end();
            }
        });
        connection.on("error", function (e) {
            log.debug("connection on error");
            return log.error("local error: " + e);
        });
        connection.on("close", function (had_error) {
            log.debug("connection on close:" + had_error);
            if (had_error) {
                if (remote) {
                    remote.destroy();
                }
            } else {
                if (remote) {
                    remote.end();
                }
            }
            log.debug("clean");
            connections--;
            remote.destroy();
            connection.destroy();
            // shadow = null;
            // encryptor = null;
            log.debug("connections: " + connections);
        });
        connection.on("drain", function () {
            log.debug("connection on drain");
            if (remote) {
                return remote.resume();
            }
        });
        connection.setTimeout(config.timeout, function () {
            log.debug("connection on timeout");
            if (remote) {
                remote.destroy();
            }
            if (connection) {
                return connection.destroy();
            }
        });
    }
        ;
}

//{port, password, server_ip, method, timeout}
function createServer(config: ExpandedConfig) {
    log.info("calculating ciphers for port " + config.port);
    // udpRelay.createServer(server_ip, port, null, null, password, method, timeout, false);
    let server = net.createServer(handlerConnection(config));

    server.on("error", (e: any) => {
        if (e.code === "EADDRINUSE") {
            log.error("Address in use, aborting");
            process.exit(1);
        } else {
            log.error("unknown error happened " + e);
        }
        process.stdout.on('drain', () => {
            process.exit(1);
        });
    });

    server.listen(config.port, config.server_ip, () => {
        log.info("server listening at " + config.server_ip + ":" + config.port + " ");
    });
}


function main() {
    console.log("\n", utils.version, "\n");
    let configArr: ExpandedConfig[] = configLib.getServerExpandedConfigArray();
    configArr.forEach((config: ExpandedConfig) => {
        log.info("start with : " + JSON.stringify(config));
        createServer(config);
    })
}

main();

