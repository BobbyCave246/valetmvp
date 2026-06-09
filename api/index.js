// Vercel serverless entry point. Vercel auto-builds files under api/ as
// functions; this one exports the shared Express app so every request routed
// here (see vercel.json) is handled by the same app we run locally.

import app from '../src/app.js';

export default app;
