# Running it

Everything runs locally: Postgres, one API, and three front ends. Payments are
in sandbox — the mock provider walks the full payment contract without moving
real money, so an order can be placed, paid, delivered, returned and refunded
end to end.

## Once

```bash
pnpm install
pnpm --filter @fashion/core build          # the shared package the others import

cp apps/api/.env.example apps/api/.env     # DATABASE_URL, BOT_TOKEN, ports
cp apps/miniapp/.env.example apps/miniapp/.env.local
cp apps/admin/.env.example apps/admin/.env.local

pnpm --filter @fashion/api prisma:migrate  # schema + the append-only triggers
pnpm --filter @fashion/api seed            # six Tashkent sellers, ~30 products
```

## Every time

```bash
./scripts/api.sh start        # API on :4000
./scripts/miniapp.sh start    # shopper Mini App on :3000
./scripts/admin.sh start      # operator panel on :3001
./scripts/bot.sh start        # Telegram bot (needs BOT_TOKEN)
```

Each script takes `start`, `stop`, `restart`, `build`, `status` and `logs`. The
two Next apps serve a production build, so after changing their code run
`build` then `restart`.

To stop everything: `./scripts/api.sh stop && ./scripts/miniapp.sh stop &&
./scripts/admin.sh stop && ./scripts/bot.sh stop`.

## Signing in

### Operator panel — http://localhost:3001

Every operator needs a second factor (ADM-002). On the first sign-in the panel
shows the TOTP key and an `otpauth://` link; add either to an authenticator app
and enter the six digits.

| Who | Email | Password | Sees |
| --- | --- | --- | --- |
| Platform owner | `super@fashion.uz` | `Platform!Admin2026` | everything |
| Catalogue | `catalog@fashion.uz` | `Catalog!Admin2026` | products, sellers, no money |
| Orders | `orders@fashion.uz` | `Orders!Admin2026` | orders, returns |
| Finance | `finance@fashion.uz` | `Finance!Admin2026` | ledger, payouts, reconciliation |
| Finance (second approver) | `finance2@fashion.uz` | `Finance!Admin2026` | same — exists so dual control works |
| Content | `content@fashion.uz` | `Content!Admin2026` | storefront, pages |
| Support | `support@fashion.uz` | `Support!Admin2026` | tickets, orders, no money |

### Seller cabinet — the same URL, http://localhost:3001

A seller login lands in the cabinet instead of the panel; the app routes on who
signed in, not on a different address.

| Seller | Email | Password |
| --- | --- | --- |
| Chorsu Atelier | `owner@chorsu.uz` | `Seller!Owner2026` |
| Atlas & Adras | `owner@atlas.uz` | `Seller!Owner2026` |

### Shopper Mini App — http://localhost:3000

In Telegram it authenticates with `initData`. Opened directly in a browser it
needs a dev session, which is off unless you ask for it:

```bash
ALLOW_DEV_SESSION=1 DEV_AUTH_SECRET=<the API's DEV_AUTH_SECRET> \
  ./scripts/miniapp.sh restart
```

The secret never reaches the browser — the sign-in goes through a route handler
on the Next server.

## A five-minute walkthrough

Worth doing in this order, because each step is what makes the next one
interesting.

1. **Shopper** (`:3000`) — ask the stylist for an outfit, e.g. *"образ на
   свадьбу, бюджет 3 млн"*. Every item it offers is a real in-stock SKU, often
   from several brands. Add the outfit, open the cart, place the order and pay
   in the sandbox.
2. **Seller** (`:3001`, `owner@chorsu.uz`) — the order is waiting with a
   confirmation deadline. Confirm it, then walk it through picking and handover.
   "Баланс и выплаты" shows the sale, the 10% commission and what is held in the
   return reserve, each as a ledger line.
3. **Finance** (`:3001`, `finance@fashion.uz`) — "Реестр" lists the same entries
   from the platform's side; "Проверить баланс" rebuilds every balance from them
   and reports the drift (it should be zero). Create a payout batch, then try to
   approve it yourself: the button is refused, because the maker cannot be the
   checker. Sign in as `finance2@fashion.uz` and it is offered.
4. **Shopper** — request a return. **Seller** — mark the parcel received and
   record the inspection per item. **Finance** — the refund reverses both the
   sale and the commission, and both reversals appear in the ledger.
5. **Platform owner** — "Аудит" has every one of those actions with its
   before/after; "Настройки" lists the decisions from Appendix D that are still
   open, and the two feature flags that are off for legal reasons rather than
   technical ones.

## Tests

```bash
pnpm --filter @fashion/core test        # 73 unit tests: money, commission, fit, state machines
pnpm --filter @fashion/bot test         # 36: the bot service channel and the notifier
pnpm --filter @fashion/miniapp test     # 9: label and copy coverage
pnpm --filter @fashion/api test:e2e     # 53 HTTP checks against a running API
pnpm --filter @fashion/miniapp test:ui  # 53 browser checks against the real Mini App
pnpm --filter @fashion/admin test:ui    # 52 browser checks against the real panel
```

The two `test:ui` suites drive a real browser against the running stack, so the
API and the app under test both need to be up. `SHOT_DIR=/some/path` makes them
write a screenshot per screen, which is the quickest way to see the whole
product at once.

## What is deliberately not live

- **Real payments.** PAYME, CLICK and Uzum adapters are written but refuse to
  start without credentials; the `mock` provider is what runs. Nothing about
  the order, ledger, payout or refund flow is mocked — only the card.
- **Photo body measurement** (D-10) and **marketing push** (NTF-002), both off
  behind flags that name what has to exist first: a DPIA for one, a signed-off
  consent flow for the other.
