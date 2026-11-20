// AWS Lambda entry point (Lab 7): runs the same Express app inside Lambda.
// Lambda setting: handler = lambda.handler
const serverless = require('serverless-http');
const app = require('./app');

module.exports.handler = serverless(app);
