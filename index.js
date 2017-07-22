// Use local .env file for env vars when not deployed
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const aws = require('aws-sdk')
const multer = require('multer')
const multerS3 = require('multer-s3')
const { Pool } = require('pg')
const { saltHashPassword, sha512 } = require('./src/password');
var SqlString = require('sqlstring');
const uuidv4 = require('uuid/v4');
const Expo = require('exponent-server-sdk');
let expo = new Expo();


const s3 = new aws.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: "us-east-1",
});

const connectionString = process.env.DATABASE_URL + '?ssl=true';

const pool = new Pool({
  connectionString: connectionString,
})


/*pool.query(`DROP TABLE users;`);
pool.query(`DROP TABLE images;`);
pool.query(`DROP TABLE friends;`);
pool.query(`DROP TABLE followers;`);*/
/*
pool.query(`CREATE TABLE users (
    username   varchar(50) PRIMARY KEY,
    salt       varchar(100) NOT NULL,
    hash       varchar(200) NOT NULL,
    token      varchar(100) NOT NULL,
    pushToken  varchar(100)
);`, (err, res) => {
  console.log(err, res)
});

pool.query(`CREATE TABLE images (
    id         SERIAL PRIMARY KEY,
    username   varchar(50) NOT NULL,
    url       varchar(200) NOT NULL
);`, (err, res) => {
  console.log(err, res)
});

pool.query(`CREATE TABLE followers (
    subscriber   varchar(50) NOT NULL,
    usernameFollowing     varchar(50) NOT NULL,
    lastImageId integer,
    UNIQUE (subscriber, usernameFollowing)
);`, (err, res) => {
  console.log(err, res)
});
*/
/*pool.query(`SELECT * from users;`, (err, res) => {
  console.log(err, res)
});*/

// Initialize multers3 with our s3 config and other options
const upload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.AWS_BUCKET,
    acl: 'public-read',
    metadata(req, file, cb) {
      cb(null, {fieldName: file.fieldname});
    },
    key(req, file, cb) {
      cb(null, uuidv4() + '.png');
    }
  })
})

// Expose the /upload endpoint
const express = require('express');
const app = express();
const http = require('http').Server(app);
var bodyParser = require('body-parser')

app.use(bodyParser.json())

app.post('/signup', (req, expressRes, next) => {
  let username = req.body.username;
  let password = req.body.password;

  if (!username || username.length < 2) {
    expressRes.status(500).send({ error: 'Choose a better username!' })
    return;
  }

  let saltAndHashObject = saltHashPassword(password);
  let salt = saltAndHashObject.salt;
  let hash = saltAndHashObject.hash;
  let token = uuidv4();
  var sql = SqlString.format('INSERT INTO users (username, salt, hash, token) VALUES (?, ?, ?, ?)', [username, salt, hash, token]);

  pool.query(sql, (err, res) => {
    if (err) {
      console.log(err);
      expressRes.status(500).send({ error: 'Something failed!' })
    } else {
      let response = {
        token: token,
      };

      expressRes.json(response);
    }
  });
});

app.post('/login', (req, expressRes, next) => {
  let username = req.body.username;
  let password = req.body.password;

  var sql = SqlString.format('SELECT * FROM users WHERE username = ?', [username]);

  pool.query(sql, (err, res) => {
    if (err || res.rows.length != 1) {
      expressRes.status(500).send({ error: 'Something failed!' })
    } else {
      var object = res.rows[0];
      var computedHash = sha512(password, object.salt);
      if (computedHash.passwordHash != object.hash) {
        expressRes.status(500).send({ error: 'Something failed!' })
      } else {
        console.log('successfully logged in');
        let response = {
          token: object.token,
        };

        expressRes.json(response);
      }
    }
  });
});

app.post('/upload', upload.single('photo'), (req, res, next) => {
  res.json(req.file)
});

function getUser(token, callback) {
  console.log('token ' + token);
  var sql = SqlString.format('SELECT * FROM users WHERE token = ?', [token]);
  pool.query(sql, (err, res) => {
    if (err || res.rows.length != 1) {
      console.warn('No user found!');
      callback('No user found!', null);
    } else {
      var object = res.rows[0];
      console.log('User with username ' + object.username + ' found');
      callback(null, object);
    }
  });
}

app.post('/pushToken', (req, expressRes, next) => {
  let token = req.body.token;
  let pushToken = req.body.pushToken;
  var sql = SqlString.format('UPDATE users SET pushToken = ? where token = ?', [pushToken, token]);
  pool.query(sql);
  console.log('updated push token');
});

app.post('/sendImage', (req, expressRes, next) => {
  let token = req.body.token;
  let url = req.body.url;

  getUser(token, (err, user) => {
    if (err) {
      expressRes.status(500).send({ error: 'Something failed!' });
      return;
    }

    let username = user.username;
    var sql = SqlString.format('INSERT INTO images (username, url) VALUES (?, ?)', [username, url]);

    pool.query(sql, (err, res) => {
      if (err) {
        expressRes.status(500).send({ error: 'Something failed!' })
      } else {
        expressRes.json({});

        notifyUsers(username);
      }
    });
  });
});

function highestIdForUsername(username, callback) {
  var sql = SqlString.format('SELECT id FROM images WHERE username = ? ORDER BY id DESC LIMIT 1', [username]);
  console.log(sql);

  pool.query(sql, (err, res) => {
    if (err || res.rows.length != 1) {
      callback(0);
    } else {
      callback(res.rows[0].id);
    }
  });
}

app.post('/follow', (req, expressRes, next) => {
  let token = req.body.token;
  let usernameFollowing = req.body.userToFollow;

  if (!usernameFollowing || usernameFollowing.length < 2) {
    expressRes.status(500).send({ error: 'Follow a better username!' })
    return;
  }

  getUser(token, (err, user) => {
    if (err) {
      expressRes.status(500).send({ error: 'Something failed!' });
      return;
    }

    let username = user.username;

    highestIdForUsername(usernameFollowing, (lastImageId) => {
      var sql = SqlString.format('INSERT INTO followers (subscriber, usernameFollowing, lastImageId) VALUES (?, ?, ?)', [username, usernameFollowing, lastImageId]);
      console.log(sql);

      pool.query(sql, (err, res) => {
        if (err) {
          expressRes.status(500).send({ error: 'Something failed!' })
        } else {
          console.log(username + ' followed ' + usernameFollowing);
          expressRes.json({});
        }
      });
    });
  });
});

app.post('/imageUrls', (req, expressRes, next) => {
  let token = req.body.token;
  getUser(token, (err, user) => {
    if (err) {
      expressRes.status(500).send({ error: 'Something failed!' });
      return;
    }

    let username = user.username;
    var sql = SqlString.format('SELECT images.url, images.id, images.username FROM images, followers WHERE followers.subscriber = ? AND followers.usernameFollowing = images.username AND images.id > followers.lastImageId ORDER BY images.id', [username]);
    pool.query(sql, (err, res) => {
      if (err) {
        console.log(err);
        return;
      }

      console.log(JSON.stringify(res.rows));
      let urls = [];
      let biggestIds = {};
      for (let i = 0; i < res.rows.length; i++) {
        if (res.rows[i].url) {
          urls.push(res.rows[i].url);
        }

        let otherUser = res.rows[i].username;
        if (!biggestIds[otherUser] || res.rows[i].id > biggestIds[otherUser]) {
          biggestIds[otherUser] = res.rows[i].id;
        }
      }

      for (var key in biggestIds) {
        var sqlUpdate = SqlString.format('UPDATE followers SET lastImageId = ? WHERE subscriber = ? AND usernameFollowing = ?', [biggestIds[key], username, key]);
        pool.query(sqlUpdate);
      }

      console.log('Found image urls ' + JSON.stringify(urls) + ' for user ' + username);
      expressRes.json({
        urls: urls,
      });
    });
  });
});

function notifyUsers(username) {
  console.log('notifying users that ' + username + ' uploaded an image');
  var sql = SqlString.format('SELECT pushToken FROM users, followers WHERE followers.usernameFollowing = ? AND followers.subscriber = users.username', [username]);
  pool.query(sql, (err, res) => {
    if (err) {
      return;
    }

    for (let i = 0; i < res.rows.length; i++) {
      if (res.rows[i].pushtoken) {
        console.log('Sending notification to ' + res.rows[i].pushtoken);
        expo.sendPushNotificationsAsync([{
          to: res.rows[i].pushtoken,
          body: username + ' just uploaded a new photo',
          data: {},
        }]);
      }
    }
  });
}

let port = process.env.PORT || 3000;
/*
  client
    .query('SELECT table_schema,table_name FROM information_schema.tables;')
    .on('row', function(row) {
      console.log(JSON.stringify(row));
    });
*/
http.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
