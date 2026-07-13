import express from 'express';
import jwt from 'jsonwebtoken';

const router = express.Router();

// Admin credentials come from the environment (.env locally, Vercel env vars
// in production) — they were previously hardcoded here and silently ignored
// whatever was set in AUTH_USERNAME / AUTH_PASSWORD.
const USERS = [
  {
    username: process.env.AUTH_USERNAME?.trim() || 'admin',
    password: process.env.AUTH_PASSWORD || 'admin123',
    role: 'admin'
  },
  {
    username: 'user',
    password: 'user123',
    role: 'viewer'
  }
];

export function requireAuth(req, res, next) {

  try {

    const authHeader =
      req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {

      return res.status(401).json({
        error: 'Unauthorized'
      });
    }

    const token =
      authHeader.replace('Bearer ', '');

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'absheron-secret'
    );

    req.user = decoded;

    next();

  } catch (e) {

    return res.status(401).json({
      error: 'Invalid token'
    });
  }
}

router.post('/login', (req, res) => {

  const { username, password } = req.body;

  const user = USERS.find(
    x =>
      x.username === username &&
      x.password === password
  );

  if (!user) {

    return res.status(401).json({
      error: 'Bad credentials'
    });
  }

  const token = jwt.sign(
    {
      username: user.username,
      role: user.role
    },
    process.env.JWT_SECRET || 'absheron-secret'
  );

  res.json({
    token,
    role: user.role,
    username: user.username
  });
});

router.get(
  '/me',
  requireAuth,
  (req, res) => {

    res.json({
      username: req.user.username,
      role: req.user.role
    });
  }
);

export default router;