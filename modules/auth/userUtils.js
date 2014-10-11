var Q = require('q');
var config = require('../config/configUtils');
/*
 get current user
 */
module.exports.getUser = function (session, callback, id) {
    if (config.isDevelopment()) {
        return callback(null,
            {
                'type': 'development',
                'userid': 12345678,
                'name': 'Developer',
                'email': 'moyerock@gmail.com',
                'avatar': 'https://lh3.googleusercontent.com/-AxuH90mY9tY/AAAAAAAAAAI/AAAAAAAAAAA/8kSyughgw6o/s96-c/photo.jpg'
            });
    } else {
        return Q.fcall(session.getById(id, 'user')).then(function (err, reply) {
            return callback(err, JSON.parse(reply));
        });
    }
};