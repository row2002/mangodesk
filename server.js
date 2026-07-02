const path = require('path');
const express = require('express');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' })); // export download form
app.use(express.static(path.join(__dirname, 'public')));

for (const name of ['connections', 'data', 'export']) {
  app.use(require('./routes/' + name));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // parse/validation/mongo errors are caused by user input → 400; the rest is on us
  const status = err.status
    || (err instanceof SyntaxError || err.name === 'BSONError' || err.name === 'MongoServerError' ? 400 : 500);
  res.status(status).json({ error: err.message });
});

const PORT = process.env.PORT || 27080;
// localhost only: the API exposes stored DB credentials and unauthenticated read/write
app.listen(PORT, '127.0.0.1', () => console.log(`MangoDesk running on http://localhost:${PORT}`));
