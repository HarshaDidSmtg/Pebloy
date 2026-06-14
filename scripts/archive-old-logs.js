// Archive old logs from artifacts/logs to artifacts/logs/archive if older than 30 days
const fs = require('fs');
const path = require('path');

const LOGS_DIR = process.env.LOGS_DIR || path.resolve(__dirname, '../artifacts/logs');
const ARCHIVE_DIR = path.join(LOGS_DIR, 'archive');
const DAYS_OLD = 30;

if (!fs.existsSync(ARCHIVE_DIR)) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

const now = Date.now();
const cutoff = now - DAYS_OLD * 24 * 60 * 60 * 1000;

// Add functionality to clear all logs
if (process.argv.includes('--clear')) {
  fs.readdirSync(LOGS_DIR).forEach(file => {
    const filePath = path.join(LOGS_DIR, file);
    if (file.endsWith('.json') || file.endsWith('.log')) {
      fs.unlinkSync(filePath);
      console.log(`Deleted: ${file}`);
    }
  });
  console.log('All logs cleared.');
  process.exit(0);
}

fs.readdirSync(LOGS_DIR).forEach(file => {
  if (file.endsWith('.json') || file.endsWith('.log')) {
    const filePath = path.join(LOGS_DIR, file);
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < cutoff) {
      const dest = path.join(ARCHIVE_DIR, file);
      fs.renameSync(filePath, dest);
      console.log(`Archived: ${file}`);
    }
  }
});
