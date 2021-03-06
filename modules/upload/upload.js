var fs = require('fs');
var path = require('path');
var config = require('../config/configUtils');
var userUtils = require('../auth/userUtils');
var pathUtils = require('./pathUtils');
var storageUtils = require('../storage/storageUtils');
var session = require('../sessions/sessionUtils');
var moment = require('moment');
var mimeUtils = require('../mime/mimeUtils');
var shareUtils = require('../storage/shareUtils');
//var logger = require('../logger/logUtils');

module.exports.bind = function (server) {
    var Files = {};

    var io = require('socket.io').listen(server);

    var respTime = function (socket) {
        socket.send((new Date()).getTime());
    };

    var onCompleted = function (sessionId, parent, name, filePath, size) {
        var mimeInfo = mimeUtils.lookup(name);
        var file = {
            name: name,
            path: filePath,
            size: size,
            mime: { t: mimeInfo.t, i: mimeInfo.i},
            modified: moment().format("M/D/YYYY h:mm A")
        };
        storageUtils.addFileBySessionId(session, sessionId, parent, file, function (err) {
            if (err)
                console.log('error on add file: ' + err + ', ' + JSON.stringify(file));
        });
        return file;
    };

    var emitChangeModel = function (socket, session, sessionId) {
        storageUtils.getStorageRecordBySessionId(session, sessionId, function (err, storage) {
            if (storage)
                socket.emit('changeModel', {'storage': storage});
        });
    };

    io.sockets.on('connection', function (socket) {
        //logger.log('a client connection established: ' + socket.id);

        respTime(socket);

        socket.on('message', function (message) {
//            console.log('received message: ' + message);
        });

        //starting upload
        socket.on('start', function (data) {
            var name = data.Name;
            var size = data.Size;
            var sessionId = data.SessionId;
            var currentPath = data.CurrentPath;
            console.log('[start] received start event: %s, size: %d, session: %s, parent:%s',
                name, size, sessionId, currentPath);

            //combine path
            userUtils.getUserRootPath(sessionId, function (err, userRootPath) {
                var filePath = path.join(userRootPath, currentPath, name);
                if (fs.existsSync(filePath)) {
                    socket.emit('errorOccurs', {error: 'File exists already.'});
                    return;
                }
                Files[name] = { // define storage structure
                    fileSize: size,
                    data: '',
                    downloaded: 0,
                    handler: null,
                    filePath: filePath,
                    parent: currentPath,
                    sessionId: sessionId
                };
                Files[name].getPercent = function () {
                    return parseInt((this.downloaded / this.fileSize) * 100);
                };
                Files[name].getPosition = function () {
                    return this.downloaded / 524288;
                };
                var position = 0;
                try {
                    console.log('[start] sessionId: %s, uploading: %s ...', sessionId, Files[name].filePath);
                    var stat = fs.statSync(Files[name].filePath);
                    if (stat.isFile()) {
                        Files[name].download = stat.size;
                        position = stat.size;
                    }
                } catch (err) {
                }
                var filePathAbsolute = path.dirname(Files[name].filePath);
                if (!fs.existsSync(filePathAbsolute)) { //ensure directory exist
                    pathUtils.mkdirAbsoluteSync(filePathAbsolute);
                }
                fs.open(Files[name].filePath, 'a', 0755, function (err, fd) {
                    if (err)
                        console.log('[start] file open error: ' + err.toString());
                    else {
                        Files[name].handler = fd;
                        socket.emit('moreData', {'name': name, 'position': position, 'percent': 0});
                    }
                });
            });
        });
        //uploading
        socket.on('upload', function (data) {
            var name = data.Name;
            var segment = data.Segment;
            var sessionId = data.SessionId;
            console.log('[upload] received upload event: %s, segment length: %d, session: %s', name, segment.length, sessionId);

            Files[name].downloaded += segment.length;
            Files[name].data += segment;
            if (Files[name].downloaded === Files[name].fileSize) {
                fs.write(Files[name].handler, Files[name].data, null, 'Binary', function (err, written) {
                    if (err)
                        console.log('[upload] file write error: ' + err.toString());
                    //uploading completed
                    var file = onCompleted(Files[name].sessionId, Files[name].parent, name, Files[name].filePath, Files[name].fileSize);

                    delete Files[name];
                    socket.emit('done', {file: file});

                    emitChangeModel(socket, session, data.SessionId);
                });
            } else if (Files[name].data.length > 10485760) { //If the Data Buffer reaches 10MB
                fs.write(Files[name].handler, Files[name].data, null, 'Binary', function (err, Writen) {
                    if (err)
                        console.log('[upload] file write error: ' + err.toString());
                    Files[name].data = ''; //Reset The Buffer
                    socket.emit('moreData', {
                        'name': name,
                        'position': Files[name].getPosition(),
                        'percent': Files[name].getPercent() });
                });
            }
            else {
                socket.emit('moreData', {
                    'name': name,
                    'position': Files[name].getPosition(),
                    'percent': Files[name].getPercent() });
            }

        });

        //starting folder creation
        socket.on('createFolder', function (data) {
            var name = data.Name;
            var sessionId = data.SessionId;
            var currentPath = data.Parent;
            userUtils.getUserRootPath(sessionId, function (err, rootPath) {
                var folderPath = path.join(rootPath, currentPath, name);
                console.log('folderPath: ' + folderPath);
                if (!fs.existsSync(folderPath)) {// not exists
                    pathUtils.mkdirAbsoluteSync(folderPath);

                    storageUtils.addFolderBySessionId(session, sessionId, currentPath, name,
                        function (err, folder) {
                            console.log('addFolderBySessionId done.');
                            if (err)
                                socket.emit('errorOccurs', {error: err});
                            else {
                                socket.emit('createFolderDone', {'folder': folder});
                                emitChangeModel(socket, session, sessionId);
                            }
                        });
                } else {
                    socket.emit('errorOccurs', {error: 'Folder exists already.'});
                }
            });
        });

        //deleting folder or file
        socket.on('delete', function (data) {
            var sessionId = data.SessionId;
            var currentPath = data.CurrentPath;
            var resourceType = data.ResourceType;
            var route = pathUtils.join(currentPath, data.Name);

            userUtils.getUserById(session, sessionId, function (err, reply) {
                if (reply) {
                    var user = JSON.parse(reply);
                    //physical delete
                    shareUtils.getSpecificStorage(user.type, user.userid, resourceType, route,
                        function (err, resource) {
                            if (resource) {
                                pathUtils.deleteTreeSync(resource.path);
                            }
                        });
                    //storage delete
                    storageUtils.deleteResourceById(session, sessionId, currentPath, data.Name, resourceType,
                        function (err) {
                            if (!err) {//refresh client storage model
                                emitChangeModel(socket, session, sessionId);
                            }
                        });
                }
            });
        });

        //sharing folder or file
        socket.on('share', function (data) {
            var sessionId = data.SessionId;
            var currentPath = data.CurrentPath;
            var resourceType = data.ResourceType;
            var route = pathUtils.join(currentPath, data.Name);
            console.log('share route:', route);

            userUtils.getUserById(session, sessionId, function (err, reply) {
                if (reply) {
                    var user = JSON.parse(reply);
                    var link = shareUtils.generateShareLinkSync(user.type, user.userid, resourceType, route);
                    link = config.getConfigs().SITE_ROOT + 'share/' + link;
                    socket.emit('shareLink', {'name': data.Name, 'link': link});
                }
            });
        });

        //renaming file
        socket.on('rename', function (data) {
            var sessionId = data.SessionId;
            var currentPath = data.CurrentPath;
            var newName = data.NewName;
            var resourceType = data.ResourceType;
            var route = pathUtils.join(currentPath, data.Name);

            console.log('rename', currentPath, data.Name, newName, resourceType);

            userUtils.getUserById(session, sessionId, function (err, reply) {
                if (reply) {
                    var user = JSON.parse(reply);

                    console.log('user', user);

                    //physical renaming
                    shareUtils.getSpecificStorage(user.type, user.userid, resourceType, route,
                        function (err, resource) {
                            if (resource) {
                                var newPath = pathUtils.renameSync(resource.path, newName);

                                //storage renaming
                                storageUtils.renameResourceById(session, sessionId, currentPath, data.Name,
                                    resourceType, newName, newPath, function (err) {
                                        if (!err) {//refresh client storage model
                                            emitChangeModel(socket, session, sessionId);
                                        }
                                    });
                            }
                        });
                }
            });
        });

        //download/preview link
        var emitLink = function (data, msgName) {
            var sessionId = data.SessionId;
            var filePath = data.FilePath;
            var usertype = 'anonymousUser'; //supply anonymous link
            var userid = '12345678';

            if (sessionId) {
                userUtils.getUserById(session, sessionId, function (err, reply) {
                    if (reply) {
                        var user = JSON.parse(reply);
                        usertype = user.type;
                        userid = user.userid;
                    }
                    var link = shareUtils.generateDownloadLinkSync(usertype, userid, filePath);
                    socket.emit(msgName, {link: link});
                });
            } else {
                var link = shareUtils.generateDownloadLinkSync(usertype, userid, filePath);
                socket.emit(msgName, {'link': link});
            }
        };
        socket.on('download', function (data) {
            emitLink(data, 'downlink');
        });

        //view link
        socket.on('view', function (data) {
            emitLink(data, 'viewLink');
        });

        //Whether need to login
        var emitLogin = function (needLogin) {
            socket.emit('mustLogin', {'mustLogin': needLogin});
        };
        socket.on('needLogin', function (data) {
            if (data.SessionId) {
                userUtils.getUserById(session, data.SessionId, function (err, reply) {
                    if (reply) {
                        emitLogin('n');
                    } else {
                        emitLogin('y');
                    }
                });
            } else {
                emitLogin('y');
            }
        });
    });
};
