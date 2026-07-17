require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16' 
});

const app = express();

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

// 🔄 1. BOOT-UP SYNC
async function cleanAndSyncFromStripe() {
    console.log("🧹 Wiping local database files...");
    
    db.serialize(async () => {
        db.run("DROP TABLE IF EXISTS cardholders");
        db.run("DROP TABLE IF EXISTS cards");
        db.run("DROP TABLE IF EXISTS card_authorizations");

        db.run(`CREATE TABLE cardholders (
            stripe_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            balance_cents INTEGER NOT NULL DEFAULT 5000 
        )`);

        db.run(`CREATE TABLE cards (
            stripe_card_id TEXT PRIMARY KEY,
            cardholder_stripe_id TEXT,
            status TEXT
        )`);

        console.log("📡 Tables ready. Cloning live profiles from Stripe...");
        try {
            const cardholdersList = await stripe.issuing.cardholders.list({ limit: 50 });
            for (const ch of cardholdersList.data) {
                db.run(
                    "INSERT OR IGNORE INTO cardholders (stripe_id, name, balance_cents) VALUES (?, ?, ?)",
                    [ch.id, ch.name, 5000]
                );
                console.log(`👤 Boot-sync Pulled Cardholder: ${ch.name} (${ch.id})`);
            }
 
            const cardsList = await stripe.issuing.cards.list({ limit: 50 });
            for (const card of cardsList.data) {
                db.run(
                    "INSERT OR IGNORE INTO cards (stripe_card_id, cardholder_stripe_id, status) VALUES (?, ?, ?)",
                    [card.id, card.cardholder.id, card.status]
                );
                console.log(`💳 Boot-sync Pulled Card: ${card.id} (Linked to ${card.cardholder.name})`);
            }
            console.log("✨ Initial boot clone complete!");
        } catch (syncErr) {
            console.error("❌ Stripe API Download Failed:", syncErr.message);
        }
    });
}

// 📥 2. REAL-TIME WEBHOOK ENGINE
app.post('/webhook', express.raw({type: 'application/json'}), (request, response) => {
  let event;
  try {
    const payloadString = request.body.toString();
    event = JSON.parse(payloadString);
  } catch (err) {
    console.error(`❌ Webhook JSON Parse Error: ${err.message}`);
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`📩 Webhook Event Caught: ${event.type}`);

  // 🔥 WEBHOOK A: Cardholder Created
  if (event.type === 'issuing_cardholder.created') {
    const cardholder = event.data.object;
    db.run(
      "INSERT OR IGNORE INTO cardholders (stripe_id, name, balance_cents) VALUES (?, ?, ?)", 
      [cardholder.id, cardholder.name, 5000]
    );
    return response.json({ received: true });
  }

  // 🔥 WEBHOOK B: Card Created
  if (event.type === 'issuing_card.created') {
    const card = event.data.object;
    db.run(
      "INSERT OR IGNORE INTO cards (stripe_card_id, cardholder_stripe_id, status) VALUES (?, ?, ?)", 
      [card.id, card.cardholder.id, card.status]
    );
    return response.json({ received: true });
  }

  // 🔥 WEBHOOK C: Real-time Transaction / Authorization Request
  // if (event.type === 'issuing_authorization.request') {
  //   const authorization = event.data.object;
    
  //   // 🌟 Look for the actual requested amount inside the pending payload if amount is 0
  //   const amountSpent = authorization.amount || (authorization.pending_request && authorization.pending_request.amount) || 0; 
  //   const stripeCardId = authorization.card.id;

  //   console.log(`🔍 Received Auth Request from Stripe for Card: ${stripeCardId}`);

  //   const query = `
  //       SELECT ch.stripe_id, ch.balance_cents, ch.name
  //       FROM cards c
  //       JOIN cardholders ch ON c.cardholder_stripe_id = ch.stripe_id
  //       WHERE c.stripe_card_id = ?;
  //   `;

  //   db.get(query, [stripeCardId], (err, row) => {
  //       if (err) {
  //           console.error(`❌ SQL Error during lookup: ${err.message}`);
  //           return;
  //       }

  //       if (!row) {
  //           console.log(`⚠️ MISMATCH: Card ${stripeCardId} was not found inside database.sqlite! Balance update skipped.`);
  //           response.writeHead(200, { 'Content-Type': 'application/json', 'Stripe-Version': '2023-10-16' });
  //           return response.end(JSON.stringify({ approved: false }));
  //       }

  //       console.log(`👤 Found Cardholder: ${row.name}. Current Balance: ${row.balance_cents}`);
        
  //       if (row.balance_cents >= amountSpent) {
  //           const updatedBalance = row.balance_cents - amountSpent;
            
  //           db.run(
  //               `UPDATE cardholders SET balance_cents = ? WHERE stripe_id = ?;`, 
  //               [updatedBalance, row.stripe_id], 
  //               (updateErr) => {
  //                   if (!updateErr) {
  //                       console.log(`💸 Success! Deducted £${(amountSpent/100).toFixed(2)}. New DB Balance: £${(updatedBalance/100).toFixed(2)}`);
  //                   }
  //                   response.writeHead(200, { 'Content-Type': 'application/json', 'Stripe-Version': '2023-10-16' });
  //                   return response.end(JSON.stringify({ approved: true }));
  //               }
  //           );
  //       } else {
  //           console.log(`❌ Declined: Insufficient funds. Needs ${amountSpent} cents.`);
  //           response.writeHead(200, { 'Content-Type': 'application/json', 'Stripe-Version': '2023-10-16' });
  //           return response.end(JSON.stringify({ approved: false }));
  //       }
  //   });
  //   return; 
  // }
  // 🔥 WEBHOOK C: Real-time Transaction / Authorization Request
  if (event.type === 'issuing_authorization.request') {
    const authorization = event.data.object;
    
    // Look for the requested amount inside the payload
    const amountSpent = authorization.amount || (authorization.pending_request && authorization.pending_request.amount) || 0; 
    const stripeCardId = authorization.card.id;

    console.log(`🔍 Received Auth Request from Stripe for Card: ${stripeCardId}`);

    const query = `
        SELECT ch.stripe_id, ch.balance_cents, ch.name
        FROM cards c
        JOIN cardholders ch ON c.cardholder_stripe_id = ch.stripe_id
        WHERE c.stripe_card_id = ?;
    `;

    db.get(query, [stripeCardId], (err, row) => {
        if (err) {
            console.error(`❌ SQL Error during lookup: ${err.message}`);
            return;
        }

        // 🚨 CRITICAL FIX FOR YOUR LOW BALANCE LOG TEST:
        if (!row) {
            console.log(`❌ Transaction Declined: Card ${stripeCardId} not found in database. (Did you forget to restart the server to sync it?)`);
            response.writeHead(200, { 'Content-Type': 'application/json', 'Stripe-Version': '2023-10-16' });
            return response.end(JSON.stringify({ approved: false }));
        }

        console.log(`👤 Found Cardholder: ${row.name}. Current Balance: £${(row.balance_cents/100).toFixed(2)}`);
        
        if (row.balance_cents >= amountSpent) {
            const updatedBalance = row.balance_cents - amountSpent;
            
            db.run(
                `UPDATE cardholders SET balance_cents = ? WHERE stripe_id = ?;`, 
                [updatedBalance, row.stripe_id], 
                (updateErr) => {
                    if (!updateErr) {
                        console.log(`💸 Success! Deducted £${(amountSpent/100).toFixed(2)}. New DB Balance: £${(updatedBalance/100).toFixed(2)}`);
                    }
                    response.writeHead(200, { 'Content-Type': 'application/json', 'Stripe-Version': '2023-10-16' });
                    return response.end(JSON.stringify({ approved: true }));
                }
            );
        } else {
            console.log(`❌ Declined: Insufficient funds. Tried to spend £${(amountSpent/100).toFixed(2)}, but only has £${(row.balance_cents/100).toFixed(2)}.`);
            response.writeHead(200, { 'Content-Type': 'application/json', 'Stripe-Version': '2023-10-16' });
            return response.end(JSON.stringify({ approved: false }));
        }
    });
    return; 
  }

  response.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await cleanAndSyncFromStripe(); 
});