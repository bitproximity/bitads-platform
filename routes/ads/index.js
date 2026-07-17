// routes/ads/index.js
const express = require('express');
const router = express.Router();

router.use('/slots', require('./slots'));
router.use('/campaigns', require('./campaigns'));
router.use('/rotation', require('./rotation'));

module.exports = router;
