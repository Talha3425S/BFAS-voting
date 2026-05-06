// utils/crypto.js
const crypto = require('crypto');

async function encryptPrivateKey(privateKeyHex, password) {
 
  const salt = crypto.randomBytes(16);
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(privateKeyHex, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

async function decryptPrivateKey(encryptedB64, password) {
  const data = Buffer.from(encryptedB64, 'base64');
  const salt = data.slice(0, 16);
  const iv = data.slice(16, 32);
  const tag = data.slice(32, 48);
  const ciphertext = data.slice(48);

  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8'); // privateKeyHex
}

module.exports = {
  encryptPrivateKey,
  decryptPrivateKey
};
