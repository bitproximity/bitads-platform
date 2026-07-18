// routes/ads/index.js
const express = require('express');
const router = express.Router();

router.use('/slots', require('./slots'));
router.use('/campaigns', require('./campaigns'));
router.use('/rotation', require('./rotation'));
router.use('/leads', require('./leads'));
router.use('/signup', require('./signup'));
router.use('/marketplace', require('./marketplace'));
router.use('/moderation', require('./moderation'));
router.use('/reporting', require('./reporting'));
router.use('/uploads', require('./uploads'));

module.exports = router;
