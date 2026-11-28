# Bizinflow — Frontend Integration Guide

This document maps every UI screen to the **existing** backend. No backend behaviour was
rewritten; one **new read-only** action was added (`getDashboard`).

## Pages

| File | Purpose | Auth |
|---|---|---|
| `index.html` | Public landing page | public |
| `login.html` | Sign in + password reset | public |
| `signup.html` | Business registration (3 versions) | public |
| `app.html` | Authenticated workspace (Home/Sales/+/Records/Profile) | session required |
| `sales.html`, `services.html` | Legacy full apps (still work) | session required |

Shared assets:
- `css/design-system.css` — brand tokens + components (navy/teal/beige/sky).
- `css/public.css` — landing/login/signup.
- `css/app.css` — authenticated shell, tables, charts, bottom nav.
- `js/api.js` — `window.BZ` client (session token, `call`, `dashboard`, auth helpers).
- `js/app/*.js` — one module per tab.

## Backend endpoints used

All authenticated calls send `Authorization: Bearer <bizSession>` to `POST /api/call`.

### Auth (public)
| UI | Endpoint | Body |
|---|---|---|
| Login | `POST /api/onboard/login` | `{ email, password }` → `{ session, code, bizName, apps, email }` |
| Sign up | `POST /api/onboard/register` | `{ businessName, email, password, appVersion }` |
| Forgot password | `POST /api/onboard/reset/request` | `{ email }` |
| Reset password | `POST /api/onboard/reset/confirm` | `{ email, otp, password }` |

`appVersion` ∈ `SALES | SVC | BOTH` → backend provisions the matching app(s).

### Data (session required)
| UI | app | fn |
|---|---|---|
| Dashboard | (cross-app) | `getDashboard` **(NEW, read-only)** |
| Sales history | `sales` | `getSalesHistory` |
| Recent sales | `services` | `getRecentSales` |
| Products | `sales` | `getProductsList` |
| Customers | `sales` / `services` | `getCustomersList` / `getCustomersWithSpend` |
| Services | `services` | `getAllServices` |
| Record sale (products) | `sales` | `saveSale` |
| Record sale (services) | `services` | `recordSale` |
| Add customer | `sales` / `services` | `addCustomer` |
| Add product | `sales` | `addProduct` |
| Add service | `services` | `addService` |
| Add expense | `services` / `sales` | `addExpense` / `addRunningExpense` |
| Settings read | `services` / `sales` | `getInitData` / `getConfig` |
| Settings write | `services` | `updateBusinessSettings` |

## New backend addition

`backend/src/dashboard.js` — `getDashboard(code, { from, to })`:
- Aggregates the business's enabled apps (Sales and/or Services).
- Returns `business`, `range`, `totals {revenue, expenses, profit}`, `counts`, `series.byDay`,
  `recent`, `expenseBreakdown`. **Read-only** — reuses existing per-app read functions.
- `core.js` dispatches `fn === 'getDashboard'` before per-app routing.
- `server.js` lets `/api/call` accept `getDashboard` without an `app` guard (still requires a session).

## Application versions (feature gating)

`login` returns `apps` (`['sales','services']`). The UI stores it in `localStorage.bizApps` and:
- **Sales plan** → product/add-product shown; services hidden.
- **Services plan** → service/add-service shown; products hidden.
- **Complete Suite** → both.

`shell.js` hides unavailable Records tabs and Quick Actions accordingly.

## Notes / limitations
- The Sales app has **no** settings-write endpoint, so Profile settings are read-only on a Sales-only plan.
- Payment status / partial payments were intentionally **excluded** (not present in backend).
- `getDashboard` runs a handful of read calls per load; acceptable for small businesses.

## Running locally
```
# frontend is static; point js/config.js API_BASE at the backend
```
