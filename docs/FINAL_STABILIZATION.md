# TCERP2 — FINAL STABILIZATION

> منبع حقیقت این مأموریت. فقط یافته‌های تأییدشده.

## وضعیت main

- HEAD: `603aaeb` (Merge PR #9: Ops CLI)
- CI: ✅ هر دو job

## PRهای باز

| PR | Branch | HEAD | Base | CI | Mergeable | Migration |
|---|---|---|---|---|---|---|
| #7 | feature/d2-portal-business-api | `80eaa91` | main | ⚠️ ۶ g7d flake (رفع در #10) | true/unstable | none |
| #10 | feature/backlog-security | `eb85307` | main | ✅ success | true/clean | `token_version` |
| #11 | feature/ops-cli-hardening | `533605d` | feature/backlog-security | — (stacked) | true/clean | none |
| #12 | feature/d2-portal-files | `80eaa91` | feature/d2-portal-business-api | ⚠️ MinIO DOWN | true/unknown | `customer_visible` |
| #13 | feature/d4-imports-exports | `3d9d50e` | main | ✅ success | true/clean | none |
| #14 | feature/d5-loading-completion | `52cb34d` | main | ✅ success (S3 NOT_TESTED) | true/clean | `loading_weighbridge` |
| #15 | feature/d3-fiscal-closing-tests | `1d08291` | main | ✅ success | true/clean | none |

## ترتیب Merge

```
۱. #10 (backlog امنیتی — فیکس g7d flake را می‌آورد)
۲. #7 (Phase 2 — پس از #10 سبز می‌شود)
۳. #11 (CLI — پس از #10 روی main CI می‌گیرد)
۴. #12 (Phase 3 — پس از #7 و #10 سبز می‌شود)
۵. #13 (D-4 — مستقل)
۶. #15 (D-3 — مستقل)
۷. #14 (D-5 — مستقل، با قید NOT_TESTED)
```

## باگ‌های رفع‌شده

| باگ | PR | قرمز→سبز |
|---|---|---|
| D2-10..13 (OTP/session/mobile-only/rate-limit/select-company//me) | #8 | ✓ |
| D2-14..18 (party scope/visibility/pagination/Origin/cookie/options) | #8 | ✓ |
| D2-19 (OTP attempts durable) | #8 | ✓ |
| Access token revocation (token_version) | #10 | ✓ |
| journal.reverse company scope | #10 | ✓ |
| Fiscal guard determinism (g7d flake) | #10 | ✓ |
| CLI atomic + env-first + fail-closed | #11 | ✓ |
| Pagination NaN/huge → 400 | #7 | ✓ |
| Customer visibility DEFAULT DENY | #12 | ✓ |
| Content-Length from TRUE buffer length | #12/#14 | ✓ |
| BigInt list serialization 500 | #14 | ✓ |

## بدهی فنی باقیمانده

| مورد | اولویت | دلیل مسدود |
|---|---|---|
| D-1 اتصال sandbox مؤدیان | P0 | اعتبارنامه مالک |
| D-3 ‏Closing Entries | P1 | تصمیم حسابدار |
| D-4 ‏GRN Import | P1 | قرارداد مالی/انبارداری |
| D-6 تطبیق بانکی/چند-ارزی | P2 | سیاست مالی |
| ارز مانده بدهی پورتال | P2 | سیاست ارز پایه |
| CI ‏Storage (MinIO) | P2 | زیرساخت عمومی gated |
| TODO(cache) permissions | P3 | نیاز عملیاتی |
