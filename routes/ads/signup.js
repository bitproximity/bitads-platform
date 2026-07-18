// routes/ads/signup.js
// Registro self-serve con verificación de email obligatoria.
//
// Flujo:
// 1. POST /tenant o /advertiser -> crea la cuenta (email_verified=false),
//    genera un token, manda el email de verificación. NO devuelve el
//    api_key todavía — evita que alguien lo use sin haber confirmado
//    ser dueño de ese email.
// 2. El usuario hace click en el link del email -> GET /verify?token=X
// 3. Ese endpoint marca email_verified=true y muestra el api_key UNA vez,
//    en una página HTML simple (no hay otra forma de recuperarlo después).
//
// Los middlewares de auth (tenantAuth/advertiserAuth) bloquean el uso del
// api_key hasta que email_verified sea true.

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../lib/supabaseClient');
const { signupLimiter } = require('../../middleware/rateLimits');
const { sendVerificationEmail } = require('../../lib/email');

const TOKEN_TTL_HOURS = 24;
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || 'https://api.bitadsapp.com';

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function verificationPage(opts) {
  const title = opts.title;
  const message = opts.message;
  const apiKey = opts.apiKey;
  const isError = opts.isError;

  const keyBlock = apiKey ? (
    '<div style="background:#171C22;border:1px solid #22272E;border-radius:8px;padding:16px;margin:24px 0;word-break:break-all;font-family:monospace;font-size:14px;color:#F5F3EF;">' +
    apiKey +
    '</div>' +
    '<p style="color:#8A9099;font-size:13px;">Guardá este key ahora, no lo vamos a volver a mostrar. Despues anda a <a href="https://admin.bitadsapp.com" style="color:#12E0C4;">admin.bitadsapp.com</a> para entrar.</p>'
  ) : '';

  const titleColor = isError ? '#FF5C5C' : '#F5F3EF';

  return (
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>BitAds</title></head>' +
    '<body style="background:#0B0E11;color:#F5F3EF;font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">' +
    '<div style="max-width:440px;padding:32px;background:#12161B;border:1px solid #22272E;border-radius:12px;">' +
    '<h2 style="color:' + titleColor + ';">' + title + '</h2>' +
    '<p style="color:#8A9099;font-size:14px;line-height:1.5;">' + message + '</p>' +
    keyBlock +
    '</div></body></html>'
  );
}

router.use(signupLimiter);

router.post('/tenant', async (req, res) => {
  const name = req.body.name;
  const contact_email = req.body.contact_email;

  if (!name || !contact_email) {
    return res.status(400).json({ error: 'name y contact_email son requeridos' });
  }
  if (!isValidEmail(contact_email)) {
    return res.status(400).json({ error: 'Email invalido' });
  }

  try {
    const existingResult = await supabaseAdmin
      .from('bitads_tenants')
      .select('id')
      .eq('contact_email', contact_email)
      .maybeSingle();

    if (existingResult.data) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese email. Si perdiste tu API key, contactanos.' });
    }

    const token = generateToken();
    const expires = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000).toISOString();

    const insertResult = await supabaseAdmin
      .from('bitads_tenants')
      .insert({
        name: name,
        contact_email: contact_email,
        status: 'active',
        email_verified: false,
        verification_token: token,
        verification_token_expires: expires
      })
      .select('id, name, contact_email')
      .single();

    if (insertResult.error) throw insertResult.error;

    const verifyUrl = API_PUBLIC_URL + '/api/ads/signup/verify?token=' + token + '&type=tenant';
    await sendVerificationEmail(contact_email, name, verifyUrl);

    res.status(201).json({ message: 'Cuenta creada. Revisa tu email para confirmarla y recibir tu API key.' });
  } catch (err) {
    console.error('[ads/signup] POST /tenant', err);
    res.status(500).json({ error: 'No se pudo crear la cuenta' });
  }
});

router.post('/advertiser', async (req, res) => {
  const name = req.body.name;
  const contact_email = req.body.contact_email;
  const industry = req.body.industry;

  if (!name || !contact_email) {
    return res.status(400).json({ error: 'name y contact_email son requeridos' });
  }
  if (!isValidEmail(contact_email)) {
    return res.status(400).json({ error: 'Email invalido' });
  }

  try {
    const existingResult = await supabaseAdmin
      .from('ads_advertisers')
      .select('id')
      .eq('contact_email', contact_email)
      .maybeSingle();

    if (existingResult.data) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese email. Si perdiste tu API key, contactanos.' });
    }

    const token = generateToken();
    const expires = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000).toISOString();

    const insertResult = await supabaseAdmin
      .from('ads_advertisers')
      .insert({
        name: name,
        contact_email: contact_email,
        industry: industry || null,
        status: 'active',
        email_verified: false,
        verification_token: token,
        verification_token_expires: expires
      })
      .select('id, name, contact_email')
      .single();

    if (insertResult.error) throw insertResult.error;

    const verifyUrl = API_PUBLIC_URL + '/api/ads/signup/verify?token=' + token + '&type=advertiser';
    await sendVerificationEmail(contact_email, name, verifyUrl);

    res.status(201).json({ message: 'Cuenta creada. Revisa tu email para confirmarla y recibir tu API key.' });
  } catch (err) {
    console.error('[ads/signup] POST /advertiser', err);
    res.status(500).json({ error: 'No se pudo crear la cuenta' });
  }
});

router.get('/verify', async (req, res) => {
  const token = req.query.token;
  const type = req.query.type;

  if (!token || (type !== 'tenant' && type !== 'advertiser')) {
    return res.status(400).send(verificationPage({
      title: 'Link invalido',
      message: 'Este link de verificacion no es valido.',
      isError: true
    }));
  }

  const table = type === 'tenant' ? 'bitads_tenants' : 'ads_advertisers';

  try {
    const fetchResult = await supabaseAdmin
      .from(table)
      .select('id, name, api_key, email_verified, verification_token_expires')
      .eq('verification_token', token)
      .single();

    if (fetchResult.error || !fetchResult.data) {
      return res.status(400).send(verificationPage({
        title: 'Link invalido o ya usado',
        message: 'Este link de verificacion ya no es valido. Si ya confirmaste tu cuenta, entra directo en admin.bitadsapp.com.',
        isError: true
      }));
    }

    const account = fetchResult.data;

    if (account.email_verified) {
      return res.send(verificationPage({
        title: 'Ya confirmada',
        message: 'Esta cuenta ya estaba confirmada. Anda a admin.bitadsapp.com para entrar con tu API key.'
      }));
    }

    if (new Date(account.verification_token_expires) < new Date()) {
      return res.status(400).send(verificationPage({
        title: 'Link vencido',
        message: 'Este link vencio (duran 24 horas). Contactanos para reactivar tu cuenta.',
        isError: true
      }));
    }

    const updateResult = await supabaseAdmin
      .from(table)
      .update({ email_verified: true, verification_token: null, verification_token_expires: null })
      .eq('id', account.id);

    if (updateResult.error) throw updateResult.error;

    res.send(verificationPage({
      title: 'Listo, ' + account.name + '!',
      message: 'Tu cuenta quedo confirmada. Este es tu API key:',
      apiKey: account.api_key
    }));
  } catch (err) {
    console.error('[ads/signup] GET /verify', err);
    res.status(500).send(verificationPage({
      title: 'Error',
      message: 'Algo salio mal al confirmar tu cuenta. Intenta de nuevo o contactanos.',
      isError: true
    }));
  }
});

module.exports = router;
