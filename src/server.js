let Encryptor, fs, inet, net, path, udpRelay, utils;

net = require("net");
fs = require("fs");
path = require("path");
udpRelay = require("./udprelay");
utils = require("./utils");
inet = require("./inet");
Encryptor = require("./encrypt").Encryptor;

function main() {
    let METHOD, SERVER, a_server_ip, config, configContent, configFromArgs, configPath,
        connections, e, k, key, port, portPassword, servers, timeout, v, _results;

    console.log(utils.version);
    configFromArgs = utils.parseArgs(true);
    configPath = 'config.json';
    if (configFromArgs.config_file) {
        configPath = configFromArgs.config_file;
    }
    if (!fs.existsSync(configPath)) {
        configPath = path.resolve(__dirname, "config.json");
        if (!fs.existsSync(configPath)) {
            configPath = path.resolve(__dirname, "../../config.json");
            if (!fs.existsSync(configPath)) {
                configPath = null;
            }
        }
    }
    if (configPath) {
        utils.info('loading config from ' + configPath);
        configContent = fs.readFileSync(configPath);
        try {
            config = JSON.parse(configContent);
        } catch (_error) {
            e = _error;
            utils.error('found an error in config.json: ' + e.message);
            process.exit(1);
        }
    } else {
        config = {};
    }
    for (k in configFromArgs) {
        v = configFromArgs[k];
        config[k] = v;
    }
    if (config.verbose) {
        utils.config(utils.DEBUG);
    }

    //检查一遍 config 的地址对不对
    utils.checkConfig(config);
    timeout = Math.floor(config.timeout * 1000) || 300000;
    portPassword = config.port_password;
    port = config.server_port;
    key = config.password;
    METHOD = config.method;
    SERVER = config.server;
    if (!(SERVER && (port || portPassword) && key)) {
        utils.warn('config.json not found, you have to specify all config in commandline');
        process.exit(1);
    }
    connections = 0;
    if (portPassword) {
        if (port || key) {
            utils.warn('warning: port_password should not be used with server_port and password. server_port and password will be ignored');
        }
    } else {
        portPassword = {};
        portPassword[port.toString()] = key;
    }
    _results = [];
    for (port in portPassword) {
        key = portPassword[port];
        servers = SERVER;
        if (!(servers instanceof Array)) {
            servers = [servers];
        }
        _results.push((function () {
            var _i, _len, _results1;
            _results1 = [];
            for (_i = 0, _len = servers.length; _i < _len; _i++) {
                a_server_ip = servers[_i];
                _results1.push((function () {
                    var KEY, PORT, server, server_ip;
                    PORT = port;
                    KEY = key;
                    server_ip = a_server_ip;
                    utils.info("calculating ciphers for port " + PORT);
                    server = net.createServer(function (connection) {
                        var addrLen, cachedPieces, clean, encryptor, headerLength, remote, remoteAddr, remotePort,
                            stage;
                        connections += 1;
                        encryptor = new Encryptor(KEY, METHOD);
                        stage = 0;
                        headerLength = 0;
                        remote = null;
                        cachedPieces = [];
                        addrLen = 0;
                        remoteAddr = null;
                        remotePort = null;
                        utils.debug("connections: " + connections);
                        clean = function () {
                            utils.debug("clean");
                            connections -= 1;
                            remote = null;
                            connection = null;
                            encryptor = null;
                            return utils.debug("connections: " + connections);
                        };
                        connection.on("data", function (data) {
                            var addrtype, buf;
                            utils.log(utils.EVERYTHING, "connection on data");
                            try {
                                data = encryptor.decrypt(data);
                            } catch (_error) {
                                e = _error;
                                utils.error(e);
                                if (remote) {
                                    remote.destroy();
                                }
                                if (connection) {
                                    connection.destroy();
                                }
                                return;
                            }
                            if (stage === 5) {
                                if (!remote.write(data)) {
                                    connection.pause();
                                }
                                return;
                            }
                            if (stage === 0) {
                                try {
                                    addrtype = data[0];
                                    if (addrtype === void 0) {
                                        return;
                                    }
                                    if (addrtype === 3) {
                                        addrLen = data[1];
                                    } else if (addrtype !== 1 && addrtype !== 4) {
                                        utils.error("unsupported addrtype: " + addrtype + " maybe wrong password");
                                        connection.destroy();
                                        return;
                                    }
                                    if (addrtype === 1) {
                                        remoteAddr = utils.inetNtoa(data.slice(1, 5));
                                        remotePort = data.readUInt16BE(5);
                                        headerLength = 7;
                                    } else if (addrtype === 4) {
                                        remoteAddr = inet.inet_ntop(data.slice(1, 17));
                                        remotePort = data.readUInt16BE(17);
                                        headerLength = 19;
                                    } else {
                                        remoteAddr = data.slice(2, 2 + addrLen).toString("binary");
                                        remotePort = data.readUInt16BE(2 + addrLen);
                                        headerLength = 2 + addrLen + 2;
                                    }
                                    connection.pause();
                                    remote = net.connect(remotePort, remoteAddr, function () {
                                        var i, piece;
                                        utils.info("connecting " + remoteAddr + ":" + remotePort);
                                        if (!encryptor || !remote || !connection) {
                                            if (remote) {
                                                remote.destroy();
                                            }
                                            return;
                                        }
                                        i = 0;
                                        connection.resume();
                                        while (i < cachedPieces.length) {
                                            piece = cachedPieces[i];
                                            remote.write(piece);
                                            i++;
                                        }
                                        cachedPieces = null;
                                        remote.setTimeout(timeout, function () {
                                            utils.debug("remote on timeout during connect()");
                                            if (remote) {
                                                remote.destroy();
                                            }
                                            if (connection) {
                                                return connection.destroy();
                                            }
                                        });
                                        stage = 5;
                                        return utils.debug("stage = 5");
                                    });
                                    remote.on("data", function (data) {
                                        utils.log(utils.EVERYTHING, "remote on data");
                                        if (!encryptor) {
                                            if (remote) {
                                                remote.destroy();
                                            }
                                            return;
                                        }
                                        data = encryptor.encrypt(data);
                                        if (!connection.write(data)) {
                                            return remote.pause();
                                        }
                                    });
                                    remote.on("end", function () {
                                        utils.debug("remote on end");
                                        if (connection) {
                                            return connection.end();
                                        }
                                    });
                                    remote.on("error", function (e) {
                                        utils.debug("remote on error");
                                        return utils.error("remote " + remoteAddr + ":" + remotePort + " error: " + e);
                                    });
                                    remote.on("close", function (had_error) {
                                        utils.debug("remote on close:" + had_error);
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
                                        utils.debug("remote on drain");
                                        if (connection) {
                                            return connection.resume();
                                        }
                                    });
                                    remote.setTimeout(15 * 1000, function () {
                                        utils.debug("remote on timeout during connect()");
                                        if (remote) {
                                            remote.destroy();
                                        }
                                        if (connection) {
                                            return connection.destroy();
                                        }
                                    });
                                    if (data.length > headerLength) {
                                        buf = new Buffer(data.length - headerLength);
                                        data.copy(buf, 0, headerLength);
                                        cachedPieces.push(buf);
                                        buf = null;
                                    }
                                    stage = 4;
                                    return utils.debug("stage = 4");
                                } catch (_error) {
                                    e = _error;
                                    utils.error(e);
                                    connection.destroy();
                                    if (remote) {
                                        return remote.destroy();
                                    }
                                }
                            } else {
                                if (stage === 4) {
                                    return cachedPieces.push(data);
                                }
                            }
                        });
                        connection.on("end", function () {
                            utils.debug("connection on end");
                            if (remote) {
                                return remote.end();
                            }
                        });
                        connection.on("error", function (e) {
                            utils.debug("connection on error");
                            return utils.error("local error: " + e);
                        });
                        connection.on("close", function (had_error) {
                            utils.debug("connection on close:" + had_error);
                            if (had_error) {
                                if (remote) {
                                    remote.destroy();
                                }
                            } else {
                                if (remote) {
                                    remote.end();
                                }
                            }
                            return clean();
                        });
                        connection.on("drain", function () {
                            utils.debug("connection on drain");
                            if (remote) {
                                return remote.resume();
                            }
                        });
                        return connection.setTimeout(timeout, function () {
                            utils.debug("connection on timeout");
                            if (remote) {
                                remote.destroy();
                            }
                            if (connection) {
                                return connection.destroy();
                            }
                        });
                    });
                    server.listen(PORT, server_ip, function () {
                        return utils.info("server listening at " + server_ip + ":" + PORT + " ");
                    });
                    udpRelay.createServer(server_ip, PORT, null, null, key, METHOD, timeout, false);
                    return server.on("error", function (e) {
                        if (e.code === "EADDRINUSE") {
                            utils.error("Address in use, aborting");
                        } else {
                            utils.error(e);
                        }
                        return process.stdout.on('drain', function () {
                            return process.exit(1);
                        });
                    });
                })());
            }
            return _results1;
        })());
    }
    return _results;
};

main();

