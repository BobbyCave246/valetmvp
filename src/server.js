// Local entry point. Imports the shared Express app and starts listening.
// (On Vercel the app is served by api/index.js instead — there is no listen.)

import app from './app.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Valet MVP running:`);
  console.log(`  Booking site : http://localhost:${PORT}/booking/`);
  console.log(`  Admin console: http://localhost:${PORT}/admin/`);
});
