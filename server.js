require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// 💡 Essential global JSON parsing middleware that your route expects
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// 📥 THE STRIPE WEBHOOK ENDPOINT
app.post('/webhook', async (req, res) => {
    const event = req.body;

    console.log(`\n📩 ==========================================`);
    console.log(`📩 Received Webhook Event: ${event.type}`);

    if (event.type === 'issuing_authorization.request') {
        const authorization = event.data.object;
        
        const stripeAuthId = authorization.id;
        const stripeCardId = authorization.card?.id;
        const merchantName = authorization.merchant_data?.name || 'Unknown Merchant';
        const amount = authorization.amount || authorization.pending_request?.amount || 0; 

        let cardholderName = 'Unknown Cardholder';
        if (authorization.card?.cardholder?.name) {
            cardholderName = authorization.card.cardholder.name;
        } else if (authorization.cardholder?.name) {
            cardholderName = authorization.cardholder.name;
        }

        console.log("📋 Parsed Stripe Payload Data:");
        console.log(`   - Auth ID: ${stripeAuthId}`);
        console.log(`   - Card ID: ${stripeCardId}`);
        console.log(`   - Cardholder: ${cardholderName}`);
        console.log(`   - Merchant: ${merchantName}`);
        console.log(`   - Amount (Cents): ${amount}`);

        let decision = false;

        try {
            // 1. Fetch the cardholder balance directly using the card ID mapping
            const cardQuery = `
                SELECT c.id AS internal_card_id, ch.id AS cardholder_id, ch.balance_cents, ch.name
                FROM cards c
                JOIN cardholders ch ON c.cardholder_id = ch.id
                WHERE c.stripe_card_id = $1 AND c.status = 'active';
            `;
            const cardRes = await pool.query(cardQuery, [stripeCardId]);

            if (cardRes.rows.length > 0) {
                const { cardholder_id, balance_cents, name } = cardRes.rows[0];
                
                // Keep cardholder name aligned with the database record
                cardholderName = name;

                // 2. Evaluate if they have enough money!
                if (balance_cents >= amount) {
                    console.log(`✅ Balance Check Passed: ${name} has ${balance_cents}p. Deducting ${amount}p...`);
                    
                    // Deduct the money from the wallet ledger
                    await pool.query(`
                        UPDATE cardholders 
                        SET balance_cents = balance_cents - $1 
                        WHERE id = $2;
                    `, [amount, cardholder_id]);

                    decision = true;
                } else {
                    console.log(`❌ Balance Check Failed: ${name} only has ${balance_cents}p. Needs ${amount}p.`);
                }
            } else {
                console.log(`❌ Card ID ${stripeCardId} not found or active in database.`);
            }

            // 3. Write final log to authorization history matching your schema rows
            const authStatus = decision ? 'approved' : 'declined';
            const queryText = `
                INSERT INTO card_authorizations (stripe_auth_id, cardholder_name, merchant_name, amount_cents, status)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *;
            `;
            const dbRes = await pool.query(queryText, [stripeAuthId, cardholderName, merchantName, amount, authStatus]);
            console.log(`✅ [DATABASE SUCCESS] Transaction logged as ${authStatus.toUpperCase()}`);

        } catch (dbErr) {
            console.error("❌ Database Operation Exception:", dbErr);
        }

        // ⚡ Immediate Handshake Response (The Core Magic Version Fix)
        const eventVersion = event.api_version || '2023-10-16'; 
        res.setHeader('Stripe-Version', eventVersion);
        res.setHeader('Content-Type', 'application/json');

        return res.status(200).send(JSON.stringify({
            approved: decision
        }));
    }

    return res.status(200).json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is active on port ${PORT}`);
});