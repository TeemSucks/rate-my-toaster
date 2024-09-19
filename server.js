const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const fs = require('fs');
const basicAuth = require('express-basic-auth');

const app = express();
const PORT = 3000;

app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());

app.set('view engine', 'ejs');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowedFormats = ['.png', '.webp', '.jpg', '.jpeg'];
  const extname = path.extname(file.originalname).toLowerCase();
  if (allowedFormats.includes(extname)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only PNG, WebP, and JPG are allowed.'));
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});

let db = new sqlite3.Database('./toasters.db', (err) => {
  if (err) {
    console.error(err.message);
  }
  console.log('Connected to the toasters database.');
});

db.run(`
  CREATE TABLE IF NOT EXISTS toasters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image TEXT,
    rating REAL DEFAULT 0,
    votes INTEGER DEFAULT 0,
    comments TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    toaster_id INTEGER,
    comment TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(toaster_id) REFERENCES toasters(id) ON DELETE CASCADE
  )
`);

app.use('/mod', basicAuth({
  users: { 'admin': 'CHANGE_ME' },
  challenge: true,
  realm: 'Admin Area'
}));

app.get('/mod', (req, res) => {
  res.render('mod');
});

app.post('/mod/delete', (req, res) => {
  const { id, password } = req.body;

  if (!id || !password) {
    return res.status(400).send('Both Toaster ID and password are required.');
  }

  if (password !== 'CHANGE_ME') { // second password incase someone gets into /mod
    return res.status(401).send('Unauthorized: Incorrect password.');
  }

  db.get('SELECT image FROM toasters WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error(err.message);
      return res.status(500).send('Internal Server Error');
    }
    if (!row) {
      return res.status(404).send('Toaster not found');
    }

    const filePath = path.join(__dirname, 'public/uploads/', row.image);
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error(err.message);
        return res.status(500).send('Failed to delete file');
      }

      db.run('DELETE FROM toasters WHERE id = ?', [id], function(err) {
        if (err) {
          console.error(err.message);
          return res.status(500).send('Failed to delete record');
        }

        res.send('Toaster deleted successfully');
      });
    });
  });
});

app.get('/', (req, res) => {
  db.all('SELECT * FROM toasters ORDER BY created_at DESC', [], (err, rows) => {
    if (err) {
      console.error(err.message);
      res.status(500).send('Internal Server Error');
      return;
    }
    res.render('index', { toasters: rows, cookies: req.cookies, banner: getRandomBanner() });
  });
});

app.get('/hall-of-fame', (req, res) => {
  db.all('SELECT * FROM toasters ORDER BY rating DESC LIMIT 5', [], (err, rows) => {
    if (err) {
      console.error(err.message);
      res.status(500).send('Internal Server Error');
      return;
    }
    res.render('hall-of-fame', { toasters: rows, banner: getRandomBanner() });
  });
});

app.get('/rules', (req, res) => {
  res.render('rules');
});

app.get('/toasters/:id/comments', (req, res) => {
  const toasterId = req.params.id;

  db.get('SELECT * FROM toasters WHERE id = ?', [toasterId], (err, toaster) => {
    if (err) {
      console.error(err.message);
      return res.status(500).send('Internal Server Error');
    }

    if (!toaster) {
      return res.status(404).send('Toaster not found');
    }

    db.all('SELECT * FROM comments WHERE toaster_id = ? ORDER BY created_at DESC', [toasterId], (err, comments) => {
      if (err) {
        console.error(err.message);
        return res.status(500).send('Internal Server Error');
      }

      res.render('comments', { toaster, comments });
    });
  });
});

app.post('/submit', upload.single('image'), (req, res) => {
  if (req.fileValidationError) {
    return res.status(400).send(req.fileValidationError);
  }

  const uploadCooldown = 1 * 60 * 60 * 1000; // 1 hour
  const userLastUpload = req.cookies.lastUploadTime;

  if (userLastUpload && (Date.now() - userLastUpload < uploadCooldown)) {
    return res.status(429).send('You can only upload one image per hour.');
  }

  const image = req.file.filename;
  db.run(`INSERT INTO toasters (image) VALUES (?)`, [image], function(err) {
    if (err) {
      console.error(err.message);
      res.status(500).send('Internal Server Error');
      return;
    }

    res.cookie('lastUploadTime', Date.now(), { maxAge: uploadCooldown });
    res.redirect('/');
  });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).send('File size is too large. Maximum size is 10 MB.');
    }
  }
  next(err);
});

app.post('/rate/:id', (req, res) => {
  const toasterId = req.params.id;
  const userRating = parseInt(req.body.rating, 10);

  if (req.cookies[`voted_on_${toasterId}`]) {
    return res.send('You have already voted on this toaster!');
  }

  if (isNaN(userRating) || userRating < 1 || userRating > 10) {
    return res.status(400).send('Rating must be between 1 and 10.');
  }

  db.get('SELECT rating, votes FROM toasters WHERE id = ?', [toasterId], (err, row) => {
    if (err) {
      console.error('Database error:', err.message);
      return res.status(500).send('Internal Server Error');
    }

    if (!row) {
      console.error('Toaster not found:', toasterId);
      return res.status(404).send('Toaster not found.');
    }

    const currentRating = row.rating;
    const currentVotes = row.votes;

    const newVotes = currentVotes + 1;
    const newRating = ((currentRating * currentVotes) + userRating) / newVotes;

    db.run('UPDATE toasters SET rating = ?, votes = ? WHERE id = ?', [newRating, newVotes, toasterId], function(err) {
      if (err) {
        console.error('Update error:', err.message);
        return res.status(500).send('Internal Server Error');
      }

      res.cookie(`voted_on_${toasterId}`, userRating);
      res.redirect('/');
    });
  });
});

app.post('/toasters/:id/comment', (req, res) => {
  const toasterId = req.params.id;
  const comment = req.body.comment;

  if (!comment || comment.trim() === '') {
    return res.status(400).send('Comment cannot be empty.');
  }

  db.run('INSERT INTO comments (toaster_id, comment) VALUES (?, ?)', [toasterId, comment], function(err) {
    if (err) {
      console.error(err.message);
      return res.status(500).send('Internal Server Error');
    }
    res.redirect(`/toasters/${toasterId}/comments`);
  });
});

app.use((req, res, next) => {
  res.status(404).render('404', { banner: getRandomBanner() });
});

function getRandomBanner() {
  const banners = fs.readdirSync(path.join(__dirname, 'public/banners'));
  const randomBanner = banners[Math.floor(Math.random() * banners.length)];
  return `/banners/${randomBanner}`;
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

