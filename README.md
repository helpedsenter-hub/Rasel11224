# Shopping BD

Responsive e-commerce starter with customer accounts, admin product/order management, and **sales-based referral attribution**.

## Important business-model boundary
This starter is a product marketplace, not an investment/deposit platform. It does not accept investment deposits, promise returns, or pay rewards merely for recruiting members. A referral reward is recorded only when an actual referred customer's order is marked `completed` by an admin. Before offering any referral reward, get local legal/accounting advice and publish clear terms, eligibility, return/refund rules, and tax treatment.

## Included
- Customer registration/login with bcrypt password hashing
- Unique referral code per customer; referral code can be supplied during registration
- Customer dashboard, order history, referral count and commission ledger
- Admin panel to add/hide products and update order status
- Referral commission created once per order after admin marks it completed
- PostgreSQL-backed data and persistent sessions
- Responsive UI

## Payment status
bKash/Nagad options are currently **manual placeholders only**. The app does not initiate or verify real mobile-wallet payments. Before taking payments, apply for the appropriate merchant account and integrate the provider's official server-side API, callback/signature verification, refunds and reconciliation. Never place merchant secrets in browser code or commit `.env` to GitHub.

## Local setup
1. Install Node.js 20+ and PostgreSQL.
2. Copy `.env.example` to `.env`.
3. Set `DATABASE_URL`, a long random `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
4. Run `npm install`, then `npm start`.
5. Open `http://localhost:3000`.

Admin is created on first startup if credentials are set. Existing admin email is not overwritten. Use a unique strong password.

## GitHub
Create a new repository named `shopping-bd`. Upload the project files; do not upload `.env` or `node_modules`.

## Render deployment
1. Create a Render PostgreSQL database.
2. Create a Render Web Service connected to your GitHub repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables:
   - `DATABASE_URL`: Render PostgreSQL Internal Database URL
   - `SESSION_SECRET`: long random secret
   - `ADMIN_EMAIL`: admin email you control
   - `ADMIN_PASSWORD`: strong unique password
   - `REFERRAL_COMMISSION_PERCENT`: e.g. `5` (maximum enforced by app is 20)
   - `NODE_ENV`: `production`
6. Deploy and test `/health` only after adding the health route if you choose to enable it; the main app is available at the Render service URL.
7. Add your own domain later from Render service Settings > Custom Domains and follow the DNS instructions.

## Before public launch
- Add CSRF protection, rate limiting, email verification, password reset and audit logs.
- Add inventory, delivery tracking, refund/cancellation, terms, privacy and contact pages.
- Integrate official merchant payment APIs and verify callbacks server-side.
- Review referral and sales-commission rules with a Bangladesh-qualified lawyer/accountant. Never pay rewards from deposits or recruitment.
- Test database backups, access control and failure cases.
