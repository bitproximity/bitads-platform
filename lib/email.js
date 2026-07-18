// lib/email.js
// Envío de emails transaccionales vía Amazon SES.
// Reusa la MISMA cuenta AWS de Bit Proximity — el dominio bitadsapp.com
// ya está verificado en el motor de envíos (confirmado por Mario).
//
// Env vars requeridas (Railway, servicio bitads-api) — son las MISMAS
// credenciales que ya usa Bit Proximity para SES:
//   AWS_ACCESS_KEY_ID
//   AWS_SECRET_ACCESS_KEY
//   AWS_REGION            (la misma región que ya usa Bit Proximity)

const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const sesClient = new SESClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const FROM_EMAIL = 'BitAds <noreply@bitadsapp.com>';

async function sendVerificationEmail(toEmail, name, verificationUrl) {
  const params = {
    Source: FROM_EMAIL,
    Destination: { ToAddresses: [toEmail] },
    Message: {
      Subject: { Data: 'Confirmá tu cuenta de BitAds', Charset: 'UTF-8' },
      Body: {
        Html: {
          Charset: 'UTF-8',
          Data: `
            <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
              <h2 style="color: #0B0E11;">Hola ${escapeHtml(name)},</h2>
              <p style="color: #333; font-size: 15px; line-height: 1.5;">
                Gracias por registrarte en BitAds. Confirmá tu email para activar tu cuenta:
              </p>
              <p style="text-align: center; margin: 32px 0;">
                <a href="${verificationUrl}" style="background: linear-gradient(90deg, #3B6FF6, #12E0C4); color: #0B0E11; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: bold; display: inline-block;">
                  Confirmar mi cuenta
                </a>
              </p>
              <p style="color: #888; font-size: 13px;">
                Si no creaste esta cuenta, podés ignorar este email.
              </p>
            </div>
          `
        },
        Text: {
          Charset: 'UTF-8',
          Data: `Hola ${name},\n\nConfirmá tu cuenta de BitAds visitando este link:\n${verificationUrl}\n\nSi no creaste esta cuenta, podés ignorar este email.`
        }
      }
    }
  };

  await sesClient.send(new SendEmailCommand(params));
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

module.exports = { sendVerificationEmail };
