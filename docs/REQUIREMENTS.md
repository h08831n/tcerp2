تو در این پروژه نقش یک Senior Software Architect + Senior Full-Stack Engineer + Database Architect + ERP/CRM Analyst + Accounting Systems Designer + UI/UX Engineer را داری.

می‌خواهم از صفر یک سیستم حرفه‌ای، Production-Ready، توسعه‌پذیر و ماژولار برای کسب‌وکار B2B خریدوفروش آهن و فولاد طراحی و پیاده‌سازی کنی.

این سیستم ترکیبی از موارد زیر است:

CRM
ERP
Sales
Purchase
Supplier Management
Price Request
Daily Pricing
Loading / Delivery Operations
Inventory
Accounting
Tax Invoicing
سامانه مؤدیان ایران
Activities
Workflow Engine
Automation Engine
Approval Engine
Notification Engine
SMS
File Management
Reporting / BI
Dashboard
Calendar
Search
Import / Export
API
Customer Portal Integration
External Integrations
Audit
Security
Queue / Background Jobs

این پروژه نباید یک Prototype سطحی باشد.

من یک سیستم واقعی برای استفاده روزانه شرکت می‌خواهم که:
- اطلاعات زیاد داشته باشد.
- چندین کاربر همزمان با آن کار کنند.
- سریع باشد.
- قابلیت توسعه در آینده داشته باشد.
- Accounting و Audit آن قابل اعتماد باشد.
- تقریباً تمام عملیات اصلی آن با Keyboard انجام شود.
- API مناسب داشته باشد.
- Queue و Background Processing داشته باشد.
- Data Integrity بسیار مهم باشد.
- Permission فقط UI-Based نباشد و حتماً Backend Enforcement داشته باشد.

==================================================
1. تکنولوژی پیشنهادی
==================================================

اگر من Stack دیگری مشخص نکردم، از یک Stack مدرن و Production-Ready استفاده کن.

پیشنهاد:

Frontend:
Next.js
React
TypeScript

Backend:
NestJS یا معماری Backend TypeScript بسیار ساختاریافته

Database:
PostgreSQL

ORM:
Prisma یا ORM حرفه‌ای مشابه

Cache / Distributed Lock:
Redis

Background Jobs:
BullMQ / Redis

File Storage:
S3 Compatible Object Storage
برای محیط Local امکان استفاده از MinIO

Real-Time:
WebSocket / Server Sent Events

Authentication:
Secure Session یا JWT + Refresh Token
با قابلیت توسعه 2FA

API:
REST استاندارد
در صورت نیاز داخلی GraphQL فقط اگر مزیت واقعی دارد

Validation:
Schema Validation در Backend

Logging:
Structured Logs

Testing:
Unit Tests
Integration Tests
End-to-End Tests

Docker:
برای Development و Production Docker Compose / Containers

کل پروژه باید Modular باشد.

Business Logic را داخل UI ننویس.

Domain Logic باید در Backend متمرکز باشد.

==================================================
2. اصول غیرقابل تغییر پروژه
==================================================

این قوانین را در تمام پروژه رعایت کن.

1)
تمام Entityهای مهم Audit History دارند.

برای هر تغییر مهم ذخیره شود:

who
when
old value
new value
action
reason در صورت نیاز

2)
حذف اطلاعات حساس یا مالی نباید باعث از بین رفتن تاریخچه شود.

در بسیاری از Entityها از:
soft delete
archive
reverse
cancel

استفاده کن.

3)
عملیات خارجی و سنگین Async هستند.

مثل:

SMS
Telegram
WhatsApp
Eitaa
Bale
Rubika
Website Publishing
Moadian
Webhook
Large Import
Large Export

UI نباید منتظر آنها بماند.

4)
سیستم Keyboard First باشد.

کاربر حرفه‌ای بتواند تقریباً بدون Mouse کار کند.

5)
تمام Permissionها Backend-Enforced باشند.

مخفی کردن Button کافی نیست.

6)
Business Data با Accounting Data و Tax Data بدون دلیل قاطی نشود.

7)
تمام تاریخ‌ها در Database به‌صورت استاندارد ذخیره شوند.

UI فارسی به‌صورت پیش‌فرض تاریخ شمسی نمایش دهد.

در Export/English Mode بتوان Gregorian نمایش داد.

8)
تمام Amountها و Quantityها باید با Decimal مناسب ذخیره شوند.

برای پول از Float استفاده نکن.

9)
تمام External Integrations باید از Adapter Pattern استفاده کنند.

10)
هر Entity مهم:
created_at
updated_at
created_by

و در صورت نیاز:
updated_by
archived_at
archived_by

داشته باشد.

==================================================
3. معماری کلی سیستم
==================================================

ماژول‌های اصلی:

CRM / Party
Product
Sales
Purchase
Price Request
Supplier Offers
Daily Pricing
Publishing
Loading
Inventory
Accounting
Checks
Banking
Reconciliation
Tax Invoice
Moadian
Activities
Workflow
Automation
Approval
Notifications
SMS
Files
Dashboard
Calendar
Search
Reports
Import / Export
Users
Roles
Permissions
Teams
Settings
Sequence / Numbering
Queue
Integrations
Customer Portal API
Audit
Backup
Monitoring

ماژول‌ها باید مستقل ولی قابل ارتباط باشند.

==================================================
4. PARTY / CRM
==================================================

به جای ساخت Entity جداگانه Customer و Supplier، یک Entity مرکزی به نام:

Party

داشته باش.

Party دو Type اصلی دارد:

PERSON
COMPANY

ولی می‌تواند چند Role همزمان داشته باشد:

CUSTOMER
SUPPLIER
DRIVER
CARRIER
PARTNER
و Roleهای آینده

مثال:

شرکت آروین می‌تواند همزمان:
Customer
و
Supplier

باشد.

--------------------------------
Company Fields
--------------------------------

name_fa
name_en
registration_number
national_id
economic_code
postal_code
website
email
phone
status
assigned_salesperson
created_at

--------------------------------
Person Fields
--------------------------------

first_name
last_name
gender
birth_date
national_code
economic_code در صورت وجود
mobile
phone
email

--------------------------------
Contacts
--------------------------------

هر Company می‌تواند چند Contact Person داشته باشد.

مثال:

شرکت X

مدیر خرید:
آقای احمدی
0912...

حسابدار:
خانم رضایی
...

مدیر فروش:
...

هر Contact:
name
position
phones
emails
is_primary

--------------------------------
Addresses
--------------------------------

Address Entity جداگانه باشد.

هر Party می‌تواند چند Address داشته باشد:

MAIN
BILLING
SHIPPING
UNLOADING
OFFICE
WAREHOUSE
OTHER

Fields:

country
province
city
address
postal_code
type

--------------------------------
Customer Owner
--------------------------------

هر Customer می‌تواند owner_user_id داشته باشد.

ولی Owner مشتری با Salesperson یک سفارش خاص متفاوت است.

مثال:

Customer Owner:
Ali

Sales Order Salesperson:
Mohammad

مدیر می‌تواند Salesperson سفارش را تغییر دهد بدون اینکه Customer Owner تغییر کند.

--------------------------------
Duplicate Detection
--------------------------------

هنگام ایجاد Party:

اگر شماره موبایل دقیقاً تکراری بود:
Creation Block شود.

اگر Name Similarity بالای حدود 85% بود:
Possible Duplicate Warning نمایش داده شود.

اگر Party متعلق به Salesperson دیگری بود:
هشدار داده شود.

--------------------------------
Customer Score
--------------------------------

Customer Scoring خودکار باشد.

Metrics می‌توانند شامل:

profit generated
tonnage
number of purchases
total paid amount
purchase frequency

باشد.

5 Level قابل تنظیم داشته باش.

مثل:

Bronze
Silver
Gold
Platinum
VIP

Level اصلی توسط Formula تعیین شود.

--------------------------------
Favorite Products
--------------------------------

سیستم بر اساس Purchase/Sales History تشخیص دهد مشتری بیشتر چه محصولاتی می‌خرد.

این اطلاعات برای:

Smart SMS
Sales Follow-up
Marketing Segmentation

استفاده شود.

==================================================
5. PRODUCT SYSTEM
==================================================

Product Architecture شبیه Odoo باشد:

Product Template
+
Product Variant

مثال:

Product Template:
میلگرد سیرجان

Attributes:
Size
Grade
Length

Variants:

میلگرد سیرجان سایز 14
میلگرد سیرجان سایز 16
...

--------------------------------
Product Fields
--------------------------------

name_fa
name_en
internal_code
category_id
brand_id
description
image
is_sellable
is_purchasable
product_type
active

--------------------------------
Brand
--------------------------------

name_fa
name_en
logo

--------------------------------
Category
--------------------------------

Hierarchical Category:

آهن‌آلات
  میلگرد
    میلگرد آجدار

--------------------------------
Dynamic Attributes
--------------------------------

Attributeها Hard-Coded نباشند.

مثال:

Size
Thickness
Width
Length
Color
Grade

Attribute و Attribute Value هر دو:

name_fa
name_en

داشته باشند.

--------------------------------
Variant Matrix UX
--------------------------------

در Sales/Purchase هنگام انتخاب Product Template بتوان Matrix باز کرد.

مثال:

Product:
میلگرد بافق

Columns:
12
14
16
18

Rows:
ترکیب سایر Attributeها

کاربر Quantity را داخل Cell وارد کند.

اگر سه Cell مقدار داشته باشند، Save باعث ایجاد 3 Line شود.

--------------------------------
Unit of Measure
--------------------------------

UOM Engine داشته باش.

UOM Category:

Weight
Length
Unit
...

Conversion Ratio.

مثال:

Purchase = KG
Sales = TON

سیستم Conversion دقیق انجام دهد.

--------------------------------
Supplier ↔ Product
--------------------------------

Supplier Product Mapping داشته باش.

یک Product می‌تواند چند Supplier داشته باشد.

Mapping بتواند در سطح:

Product Template
Product Variant
Product Group

باشد.

==================================================
6. TAX PRODUCT
==================================================

Product عملیاتی را با Tax Product یکی نکن.

مثال:

Operational Product:
میلگرد 16 سیرجان

Tax Product:
میلگرد آجدار سایز 16 جهان فولاد سیرجان

Tax Product فقط برای:

Tax Invoice
Moadian

استفاده شود.

Fields:

name
tax_item_code
unit
active

Tax Product نباید Inventory یا Operational Sales Report را تغییر دهد.

==================================================
7. TAX DEFINITIONS
==================================================

Tax Rateهای استفاده‌شده در اسناد نباید بعداً تغییر کنند.

اگر Tax Rate تغییر کرد:

Tax جدید ایجاد کن.

مثال:

VAT 9%
بعداً
VAT 10%

Tax 9% قبلی حذف یا تغییر داده نشود.

Historical Documents باید Tax خودشان را حفظ کنند.

Document Line باید Tax Snapshot مناسب داشته باشد.

==================================================
8. SALES CRM FLOW
==================================================

Flow:

Lead
→ Opportunity
→ Quotation
→ Sales Order
→ Loading
→ Completed

Customer با Lead یکی نیست.

Customer قدیمی برای خرید جدید Opportunity جدید دریافت می‌کند.

==================================================
9. QUOTATION و SALES ORDER
==================================================

Quotation و Sales Order جدول جدا نداشته باشند.

یک Entity مشترک:

SalesDocument

داشته باش.

مثال:

SD-1405-00125

ابتدا:

status = QUOTATION

بعد از تأیید مشتری:

همان Document
همان Number

status = SALES_ORDER

شماره جدید نساز.

--------------------------------
Sales Document Fields
--------------------------------

customer
salesperson
date
expiration_date
currency
payment_term
delivery_address
language
quotation_template
status
created_by
created_at

--------------------------------
Sales Lines
--------------------------------

product_variant
description_printable
quantity
uom
unit_price
tax
discount
line_total
notes

Printable Description با Product Name جدا باشد.

Default آن Product + Attributes است ولی Salesperson بتواند متن چاپی را ویرایش کند.

--------------------------------
Confirmed Order Lock
--------------------------------

پس از Customer Confirmation:

product
quantity
price

برای User عادی Locked شوند.

Manager/Authorized User بتواند Override کند.

هر Override:

old_value
new_value
user
datetime
reason

در Audit ثبت شود.

==================================================
10. LOST QUOTATION / FOLLOW-UP
==================================================

Salesperson باید List پیش‌فاکتورهایی را ببیند که Sales Order نشده‌اند.

برای Lost Quote:

Lost Reason ثبت شود.

مثال:

Price too high
Bought from competitor
No longer needed
Delay
Other

Lost Reasons قابل تنظیم باشند.

گزارش تجمیعی Lost Reasons داشته باش.

==================================================
11. PURCHASE
==================================================

Purchase مستقل باشد.

برای ساخت Purchase الزام وجود Price Request نداشته باشد.

از Sales Document بتوان:

Create Purchase

و از Purchase:

Create Sale

داشت.

==================================================
12. SALES ↔ PURCHASE MANY-TO-MANY
==================================================

یک Sale ممکن است از چند Purchase تأمین شود.

یک Purchase ممکن است چند Sale را پوشش دهد.

Relation باید Many-to-Many باشد.

ترجیحاً Line-Level Allocation نیز داشته باشد.

مثال:

Purchase Line:
50 ton rebar

Allocation:
20 ton → SO-100
30 ton → SO-101

==================================================
13. DOCUMENT FLOW
==================================================

بالای هر Document مهم Related Documents نمایش بده.

مثال روی Sales Order:

3 Purchases
2 Loadings
2 Tax Invoices
4 Payments

هر Count قابل کلیک باشد.

روی Purchase نیز عکس این ارتباطات نمایش داده شود.

DocumentRelation عمومی در صورت نیاز داشته باش ولی FKهای Core را نیز به‌صورت صریح حفظ کن.

Relation Types:

created_from
related
generated_from
based_on

==================================================
14. PRICE REQUEST
==================================================

Price Request مستقل باشد.

Fields:

requester
customer optional
date
status
lines

هر Line:

product
quantity
uom

اگر امروز Product Price موجود بود نشان بده:

Today's Price = X

ولی همچنان کاربر بتواند Price Request ثبت کند.

--------------------------------
Previous Day Requests
--------------------------------

درخواست بدون پاسخ دیروز حذف یا Duplicate نشود.

در لیست امروز هم دیده شود ولی Label بخورد:

Previous Day
Older Request

==================================================
15. SUPPLIER OFFERS
==================================================

برای یک Price Request Line چند Supplier Offer ثبت شود.

مثال:

میلگرد 16 سیرجان

Supplier A = 34,300
Supplier B = 34,450
Supplier C = 34,250

Fields:

supplier
price
notes
date
time
payment_terms optional
delivery_time optional

--------------------------------
Supplier Intelligence
--------------------------------

Average Price معیار اصلی نباشد.

به دلیل Daily Volatility، مهم است سیستم تشخیص دهد:

Which supplier was the cheapest for this product on this day?

و گزارش تاریخی:

Supplier X:
in last 60 days
was daily lowest 22 times.

از این داده برای Supplier Suggestion استفاده کن.

==================================================
16. PRICE REQUEST → SALE/PURCHASE
==================================================

Price Request فقط Reference است.

دکمه:

Create Sale
Create Purchase

داشته باشد.

ولی Price Request اجباری نیست.

Purchase و Sale مستقل قابل ایجادند.

==================================================
17. DAILY PRICING ENGINE
==================================================

سیستم قیمت روزانه برای Product/Variant داشته باش.

Price Record:

product_variant
price
date
effective_at
source
created_by

Full Price History ذخیره شود.

--------------------------------
Bulk Update
--------------------------------

UI اجازه:

percentage increase
percentage decrease
fixed amount increase
fixed amount decrease
inline edit

بدهد.

==================================================
18. PRICE PUBLISHING
==================================================

قیمت‌ها بتوانند به:

Website
Telegram
WhatsApp
Eitaa
Bale
Rubika

ارسال شوند.

هر Channel Job مستقل باشد.

مثال:

Publish Batch #120

Telegram → Success
Website → Success
Eitaa → Failed
Rubika → Pending

Failure یک Channel نباید بقیه را متوقف کند.

==================================================
19. LOADING
==================================================

Loading یک Entity بسیار مهم است.

Fields:

date
product_variant
actual_quantity
uom
driver_party_id
carrier_party_id
weighbridge_image
bill_of_lading
attachments
created_by

Driver و Carrier همان Party با Role مربوطه باشند.

Fleet Module مستقل فعلاً نساز.

Transportation Cost فعلاً نساز.

--------------------------------
Actual Quantity
--------------------------------

مثال:

Order Quantity:
48,000 kg

Loading 1:
24,200

Loading 2:
24,300

Actual Loaded:
48,500

Operational calculations باید Actual Completed Loading را در نظر بگیرند.

سه Quantity مفهوم متفاوت هستند:

ordered_quantity
loaded_quantity
tax_invoiced_quantity

اینها الزاماً برابر نیستند.

--------------------------------
Loading Enter Once
--------------------------------

Loading نباید هم در Purchase و هم در Sale دوباره ثبت شود.

یک Loading Record ساخته شود.

سپس به Purchase Line و Sales Line Link شود.

در 1:1 System Auto-Match کند.

در Many-to-Many User Allocation انتخاب کند.

==================================================
20. DEBT و LOADING
==================================================

Customer Debt مانع Loading نشود.

سیستم Warning دهد.

اما اطلاعات حساس Driver ممکن است تا Manager Approval به مشتری نمایش داده نشود.

هیچ Customer Delivery Confirmation جداگانه ایجاد نکن.

Workflow:

Loading
↓
Customer Has Debt?
↓ yes
Driver info hidden
↓
Manager Approval
↓
Approved
↓
Driver info available to Customer/SMS/Portal

==================================================
21. INVENTORY
==================================================

Inventory از ابتدا وجود داشته باشد حتی اگر فعلاً Physical Warehouse نداریم.

Support:

Supplier → Customer

و آینده:

Supplier → Warehouse
Warehouse → Customer

--------------------------------
Automatic Stock Movement
--------------------------------

Routine Manual Inventory Entry نمی‌خواهم.

Stock Movement از:

Purchase
Loading
Transfer
Sales

به صورت خودکار ایجاد شود.

Stock Reservation فعلاً نداریم.

Serial / Lot / Batch نداریم.

Production / MRP نداریم.

==================================================
22. OPERATIONAL PROFIT
==================================================

Operational Profit از:

Sales Order
Purchase Order
Actual Completed Loading Quantity

محاسبه شود.

Tax Invoice را برای Operational Profit استفاده نکن.

Tax Invoice فقط Tax/Accounting Document است.

==================================================
23. SALES TAX INVOICE و PURCHASE TAX INVOICE
==================================================

دو Entity جدا:

SalesTaxInvoice
PurchaseTaxInvoice

داشته باش.

Salesperson به Tax Invoice دسترسی نداشته باشد.

Accountant / Financial Roles آن را مدیریت کنند.

==================================================
24. TAX INVOICE QUANTITY / PRICE
==================================================

Tax Invoice لازم نیست Quantity یا Unit Price یکسان با Operational Order داشته باشد.

مثال:

Operational Sale:
48.5 ton × 30M

Tax Invoice:
50 ton × adjusted unit price

اگر Business/Tax Policy اجازه می‌دهد Total Amount موردنظر ایجاد شود.

بنابراین Quantity Equality را Enforce نکن.

--------------------------------
Total Reconciliation
--------------------------------

Invoice Total را با Related Operational Order مقایسه کن.

مثال:

Order:
5,000,000,000

Related Tax Invoices:
4,600,000,000

System Warning:
400,000,000 not covered.

Warning باشد، Block الزامی نه.

==================================================
25. ORDER ↔ TAX INVOICE MANY-TO-MANY
==================================================

Relation Many-to-Many.

مثال:

Sales Order 100
→ Tax Invoice A
→ Tax Invoice B

همچنین:

Tax Invoice X
→ Sales Order 101
→ Sales Order 102

همین برای Purchase.

Relation Fields:

allocated_amount
allocated_quantity optional

--------------------------------
Moadian Status on Order
--------------------------------

روی Sales/Purchase Order نمایش بده:

Not Registered
Partially Registered
Fully Registered
Error

همچنین:

Moadian Invoice Count
Covered Amount

مثال:

Moadian:
Registered

Invoices:
3

Covered:
100%

==================================================
26. ACCOUNTING CORE
==================================================

Double Entry Accounting واقعی داشته باش.

Modules:

Chart of Accounts
Fiscal Years
Accounting Periods
Journals
Journal Entries
Journal Lines
General Ledger
Subsidiary Ledger
Trial Balance
Balance Sheet
Profit & Loss
Receivable
Payable
Banks
Receipt
Payment
Checks
Reconciliation

==================================================
27. JOURNAL ENTRY
==================================================

هر Accounting Document چند Line داشته باشد.

Header:

number
date
journal
document_type
overall_description
status
created_by

Lines:

account
party/detail
debit
credit
description

هر Line توضیح مستقل داشته باشد.

==================================================
28. DESCRIPTION TEMPLATE ENGINE
==================================================

برای Journal Line شرح‌های آماده داشته باش.

مثال:

یک فقره برداشت از {Bank_From} و واریز به {Bank_To}

یک فقره واریز به {Bank} توسط {Partner}

یک فقره برداشت از {Bank} و پرداخت به {Partner}

مدیر بتواند:

add
edit
disable
reorder

کند.

User بتواند Template انتخاب کند و ادامه متن خودش را بنویسد.

مثال:

Template:
یک فقره واریز به صادرات توسط

User:
آقای روان بابت تسویه خرید میلگرد

Result:
یک فقره واریز به صادرات توسط آقای روان بابت تسویه خرید میلگرد

==================================================
29. BANK FEE
==================================================

Bank Fee یک Line داخل همان Journal Entry است.

مثال دریافت 500,000,000 با کارمزد 500,000:

Debit Bank:
499,500,000

Debit Bank Fee Expense:
500,000

Credit Customer:
500,000,000

شرح Line مربوط به Fee به صورت Default:

کارمزد انتقال وجه

قرار گیرد.

قابل ویرایش باشد.

==================================================
30. INVOICE NEVER DIRECTLY CHANGES BANK
==================================================

Sales Tax Invoice:

Dr Receivable
Cr Sales/Revenue
Cr VAT

Purchase Tax Invoice:

Dr Purchase/Inventory
Dr VAT
Cr Payable

Bank فقط با:

Receipt
Payment
Cleared Incoming Check
Paid Outgoing Check

تغییر می‌کند.

==================================================
31. OPERATIONAL PAYMENT CLAIM
==================================================

Salesperson بتواند داخل Sale ثبت کند:

Customer says:
500M paid.

این Record نباید بلافاصله Bank Accounting Entry محسوب شود.

یک Operational Payment Claim ایجاد کن.

Status:

UNMATCHED
MATCHED
REJECTED

وقتی Salesperson آن را ثبت کرد:

Operational Customer Balance می‌تواند موقتاً کاهش یابد.

ولی هنوز Accounting Confirmed نیست.

==================================================
32. PAYMENT RECONCILIATION
==================================================

Accountant Bank activity را بررسی می‌کند.

اگر Payment واقعی پیدا شد:

MATCHED

اگر پیدا نشد:

REJECTED

Example:

Salesperson:
500M payment declared.

Accountant:
No such incoming bank payment.

Reject Reason:
مبلغ به حساب شرکت واریز نشده است.

Result:

Payment Claim record حذف نشود.

status = REJECTED

Operational balance effect revert شود.

Customer debt دوباره افزایش یابد.

Notifications:

Salesperson
Sales Manager / Manager

Timeline Event ساخته شود.

Audit ثبت شود.

==================================================
33. BANK LEDGER ORDER
==================================================

برای Bank Entry از Manual Time-of-Day استفاده نکن.

ترتیب همان ترتیب واقعی واردکردن/Import بانک در همان روز باشد.

Fields:

bank_account
date
sequence_no

مثال:

Date: 1405/07/10

1 → Incoming 500M
2 → Outgoing 300M
3 → Fee 50K

بعد از هر Row:
running_balance

نمایش بده.

اگر ترتیب عوض شد:
Balances after that row recalculate شوند.

==================================================
34. CHECK MANAGEMENT
==================================================

Incoming Check
Outgoing Check

داریم.

صرف ثبت Check نباید Bank Balance را تغییر دهد.

Incoming statuses مثلاً:

REGISTERED
PENDING
DEPOSITED
CLEARED
BOUNCED
CANCELLED

Outgoing:

REGISTERED
PENDING
PAID
BOUNCED/CANCELLED

وقتی Incoming Check CLEARED شد:
Bank Entry ایجاد شود.

وقتی Outgoing PAID شد:
Bank Entry ایجاد شود.

Due Date Notifications داشته باش.

==================================================
35. FISCAL YEAR
==================================================

Fiscal Year:

start_date
end_date
status

Status:

OPEN
CLOSED

Opening Entry
Closing Entry

پشتیبانی شود.

بعد از Close:
Editing عادی اسناد ممنوع باشد.

==================================================
36. OPENING BALANCE
==================================================

برای مهاجرت از نرم‌افزار فعلی امکان Import:

Customer Balances
Supplier Balances
Bank Balances
Check Balances
Accounts

به عنوان Opening Balance وجود داشته باشد.

==================================================
37. JOURNAL ENTRY STATUS
==================================================

DRAFT
POSTED
REVERSED
CANCELLED

Posted Document نباید مستقیم Edit/Delete شود.

اصلاح با Reverse / Adjustment انجام شود.

==================================================
38. FINANCIAL RESPONSIBILITY / ACCOUNT GROUP
==================================================

مثال:

Mr. Ravan
برای خودش و دو Party دیگر مسئول پرداخت است.

هر سه Party مستقل باقی بمانند.

Tax Invoice هر شخص نیز می‌تواند جدا باشد.

ولی:

financial_responsible_party_id

یا Account Group داشته باش.

Reports:

Individual Balance
Consolidated Responsibility Balance

مثال:

A owes 500M
B owes 300M
Ravan owes 200M

Ravan Group Total:
1B

==================================================
39. سامانه مؤدیان
==================================================

این یک Module کامل است.

فقط یک Button ارسال نساز.

Components:

Connection Settings
Pre Validation
Submission Queue
Submission History
Status Inquiry
Error Handling
Retry
Incoming Purchase Invoices
Invoice Reconciliation
Corrective Invoice
Cancellation Invoice
Sales Return
Reports
Notifications

==================================================
40. MOADIAN CONNECTION
==================================================

Configهای موردنیاز مثل:

Fiscal Memory Identifier
Economic Information
Credentials
Private Keys
API Settings
Connection Status

Secrets را Encrypt کن.

Secrets داخل Normal JSON Settings Export قرار نگیرند.

==================================================
41. SEND TAX INVOICE TO MOADIAN
==================================================

Sales Tax Invoice دارای:

Send to Moadian

باشد.

Bulk Send نیز داشته باش.

ارسال Async از Queue انجام شود.

==================================================
42. MOADIAN STATUS
==================================================

فقط Boolean sent استفاده نکن.

مثال Status:

NOT_SENT
QUEUED
SENDING
SUBMITTED
WAITING_RESULT
SUCCESS
FAILED
NEEDS_REVIEW

Server response status نیز جدا ذخیره شود.

==================================================
43. MOADIAN SUBMISSION HISTORY
==================================================

هر Attempt جداگانه ذخیره شود.

Fields:

invoice_id
attempt_no
uid
reference_number
tax_number
request_time
response_time
status
error_code
error_message
raw_response
created_by

مثال:

Attempt 1
FAILED

Attempt 2
FAILED

Attempt 3
SUCCESS

هیچ History حذف نشود.

==================================================
44. MOADIAN PREVALIDATION
==================================================

قبل از Queue شدن:

Seller Data
Buyer Data
Tax Product
Tax Item Code
UOM
Tax Rate
Required Fields
Invoice Pattern
Totals

را validate کن.

اگر Internal Validation Failed:
اصلاً API Call انجام نده.

==================================================
45. MOADIAN STATUS INQUIRY
==================================================

بعد از Submission اگر Final Status آماده نیست:

System خودش Scheduled Inquiry بسازد.

Example:

Submit
→ reference received
→ wait
→ inquire
→ still pending
→ schedule new inquiry
→ final response

Manual "Recheck Status" نیز داشته باش.

==================================================
46. CORRECTIVE / CANCELLATION / RETURN
==================================================

بعد از Moadian Registration Invoice را Raw Edit نکن.

Operations:

Create Corrective Invoice
Create Cancellation Invoice
Create Sales Return Invoice

رکورد جدید بساز.

Original Tax Invoice reference را حفظ کن.

==================================================
47. MOADIAN PURCHASE INBOX
==================================================

فاکتورهایی که Supplier برای شرکت در مؤدیان ارسال کرده در:

Moadian Purchase Inbox

نمایش داده شوند.

Incoming Tax Invoice بتواند با Internal Purchase Tax Invoice Match شود.

Match suggestions based on:

supplier
date
amount
tax number
other identifiers

Statuses:

UNMATCHED
MATCHED
MISMATCH
NEEDS_REVIEW

==================================================
48. BUYER RESPONSE
==================================================

برای Incoming Moadian Invoice Response State ذخیره کن:

Pending
Approved
Rejected

Reason نیز ثبت شود.

Audit داشته باشد.

==================================================
49. ACTIVITY ENGINE
==================================================

Activity Entity عمومی.

Fields:

type
title
description
related_entity_type
related_entity_id
created_by
assigned_to
priority
scheduled_date
due_date
status
completed_at

created_by می‌تواند:

USER
SYSTEM

باشد.

Activity Types Dynamic باشند.

Example:

Call
Meeting
Price Follow-Up
Payment Follow-Up
Visit
Send Sample

Completed Activity برای Normal User Locked باشد.

Manager Edit با Audit امکان‌پذیر باشد.

==================================================
50. WORKFLOW ENGINE
==================================================

Workflow Engine را ساده طراحی نکن.

باید یک State Machine عمومی و Configurable باشد.

Components:

Workflow Definition
States
Transitions
Transition Conditions
Required Fields
Role/Permission Rules
Field Locking
Approvals
Timers
Escalations
Reopen
Rollback
Transition Actions

Entities ممکن:

Sales
Purchase
Price Request
Loading
Payment
Check
Invoice
Activity
Approvals

--------------------------------
Example
--------------------------------

Sales:

DRAFT
↓
QUOTATION
↓
CUSTOMER_CONFIRMED
↓
SALES_ORDER
↓
PARTIALLY_LOADED
↓
COMPLETED
↓
CLOSED

Transition:
QUOTATION → CUSTOMER_CONFIRMED

Requirements:

customer exists
minimum one line
price exists

Transition:
SALES_ORDER → COMPLETED

Condition:

loading completed

--------------------------------
Field Locking
--------------------------------

At QUOTATION:
price editable

At CONFIRMED:
price locked

Manager Override:
allowed with permission + reason + audit

--------------------------------
Conditional Transition
--------------------------------

IF Customer Debt > 0
THEN Require Manager Approval
ELSE Continue

--------------------------------
Role-Based Transition
--------------------------------

Salesperson may Confirm Quotation.

Only Sales Manager may Reopen Confirmed Order.

--------------------------------
Reopen
--------------------------------

COMPLETED → REOPENED

only manager
reason required
audit required

==================================================
51. APPROVAL ENGINE
==================================================

Approval جزء Platform عمومی باشد.

Approval Request:

entity_type
entity_id
approval_type
requested_by
requested_from / role
status
reason
decision_note
created_at
decided_at

Statuses:

PENDING
APPROVED
REJECTED
CANCELLED

Support:

Single Approver
Role-Based Approver
Sequential Approval

Example:

Release Driver Info for Debtor Customer

Loading
→ Customer debt found
→ Approval Request to Manager
→ approved
→ driver data visible

==================================================
52. AUTOMATION ENGINE
==================================================

Automation Engine یکی از مهم‌ترین بخش‌های سیستم است.

آن را بسیار دقیق و قابل اعتماد طراحی کن.

Architecture:

TRIGGER
→ FILTER
→ CONDITIONS
→ DELAY/SCHEDULE
→ ACTIONS
→ ERROR HANDLING

--------------------------------
Triggers
--------------------------------

Record Created
Record Updated
Field Changed
Status Changed
Record Archived
Date Reached
Before Date
After Date
Manual Trigger
API Event
Queue Result
Approval Result
Payment Matched
Payment Rejected
Price Changed
Loading Completed
Moadian Status Changed

--------------------------------
Complex Conditions
--------------------------------

Support:

AND
OR
nested conditions

Example:

(Customer debt > 0 AND loading.quantity > 0)
OR customer.risk_flag = true

--------------------------------
Actions
--------------------------------

Create Activity
Update Field
Change Status
Create Related Record
Send Notification
Send SMS
Create Approval
Assign User
Add Tag
Create Queue Job
Generate Document
Run Calculation
Webhook/API Call
Add Timeline Event

--------------------------------
Delayed Automation
--------------------------------

Example:

Trigger:
Quotation Sent

Delay:
3 days

Then:
IF still not Sales Order

Create follow-up activity.

Important:

اگر Quotation قبل از 3 روز Confirm شد،
Pending delayed action Cancel شود.

--------------------------------
Recurring Rules
--------------------------------

Example:

Every day:
find overdue checks
notify accountant

Every day:
find overdue activities
notify user

After 2 more days:
notify manager

--------------------------------
Idempotency
--------------------------------

Automation Event ممکن است دوبار Delivery شود.

نباید:

SMS twice
Activity twice
Approval twice

ایجاد شود.

Automation Run و Action Execution Unique IDs داشته باشند.

--------------------------------
Retries
--------------------------------

External Action Failure:

retry policy

Example:

SMS attempt 1 failed
retry after 1 min
retry after 5 min
retry after 15 min

--------------------------------
Automation Logs
--------------------------------

هر Run:

automation_rule_id
version
trigger
record
conditions_result
actions
action_status
errors
retry_count
started_at
finished_at

--------------------------------
Test Mode
--------------------------------

قبل از Enable Rule:

TEST RULE

نمایش:

125 records match

Actions that would happen:
125 Activities
125 Notifications

ولی واقعاً اجرا نکن.

--------------------------------
Versioning
--------------------------------

Automation Rule changes نسخه داشته باشند.

Run قدیمی باید به Rule Version قدیمی اشاره کند.

--------------------------------
Manual Run
--------------------------------

User مجاز بتواند:

Run Automation

روی یک Record یا Selected Records اجرا کند.

==================================================
53. NOTIFICATION ENGINE
==================================================

Notification Rule قابل تنظیم باشد.

Fields:

event
recipients
channels
delay
priority
enabled

Recipient examples:

record owner
salesperson
manager
specific role
specific user

Example:

Payment Rejected

Recipients:
Salesperson
Sales Manager

Channel:
In-App

--------------------------------
Notification Center
--------------------------------

Bell icon.

Statuses:

UNREAD
READ
ARCHIVED

Notification باید deep-link به related entity داشته باشد.

Example:

پرداخت سفارش SO-10025 رد شد.

Reason:
مبلغ به حساب ننشسته است.

Open Sales Order

--------------------------------
Notification Rules Management
--------------------------------

Manager can:

add
edit
enable
disable
change recipient
change channel
change delay

==================================================
54. SMS ENGINE
==================================================

SMS باید یک Action عمومی باشد.

SMS Templates:

Order Confirmed
Loading
Payment Reminder
Check Due
Price Notification
Custom

Placeholder support:

{name}
{order_number}
{amount}
{driver}
...

هر Send log داشته باشد:

automatic/manual
provider
status
sent_at
error

Manual resend داشته باشد.

==================================================
55. SMART SMS
==================================================

Version 1 Rule-Based.

Example:

Customer purchased Rebar in last 90 days
AND
Rebar price decreased today

→ Suggest SMS

Auto-Send فقط زمانی که Explicit Rule اجازه دهد.

در آینده AI Segmentation قابل اضافه‌شدن باشد.

==================================================
56. CALENDAR
==================================================

Central Calendar.

Views:

Day
Week
Month
Agenda

Layers:

Activities
Meetings
Reminders
Check Due Dates
Payment Reminders
Approval Deadlines

User بتواند Layerها را on/off کند.

Activity creation directly from calendar.

==================================================
57. TIMELINE
==================================================

هر Entity مهم Timeline داشته باشد.

Customer Timeline مثال:

Lead created
Quotation sent
Phone call completed
Order confirmed
Loading registered
Payment declared
Payment rejected
Tax Invoice issued

Timeline events clickable باشند.

Noise Control:

مدیر بتواند مشخص کند کدام Event Types در Timeline عمومی نمایش داده شوند.

==================================================
58. FILE SYSTEM
==================================================

Central File System.

File only stored physically once.

Use:

content hash

اگر Duplicate File Upload شد:
Blob جدید نساز.

Attachment relation جدید ایجاد کن.

File Entity:

id
filename
mime_type
size
hash
storage_path
created_by

FileAttachment:

file_id
entity_type
entity_id
category
created_at

یک File می‌تواند همزمان به چند Entity وصل باشد.

Preview:

Image
PDF
...

Permissions:

View
Download
Delete
Replace

==================================================
59. USERS / ROLES
==================================================

User:

name
username
email
mobile
status
language
timezone
last_login

Roleها Dynamic باشند:

Salesperson
Sales Manager
Buyer
Purchase Manager
Accountant
Financial Manager
Pricing User
Administrator

یک User چند Role داشته باشد.

==================================================
60. PERMISSIONS
==================================================

Permission فقط Module-Level نباشد.

Support:

Module Access
Create
View
Edit
Delete/Archive
Confirm
Cancel
Reopen
Export
Import
Sensitive Actions
Workflow Transitions
Approval
Field Access
Record Scope

--------------------------------
Record Scope
--------------------------------

OWN
ASSIGNED
TEAM
ALL

مثال:

Salesperson:
Own Customers

Sales Manager:
Team Customers

Admin:
All

--------------------------------
Sensitive Field Permissions
--------------------------------

Example:

purchase price
profit
accounting details
tax invoices

Modes:

HIDDEN
READ_ONLY
EDITABLE

--------------------------------
Teams
--------------------------------

Team:

name
manager
members

--------------------------------
User Override
--------------------------------

Roles default permissions بدهند.

در موارد خاص User Override ممکن باشد.

--------------------------------
Delegation
--------------------------------

Approval delegation.

Example:

Manager absent from 10 Oct to 20 Oct
delegate approvals to Mohammad

==================================================
61. SECURITY
==================================================

Password Policy
Optional 2FA
Session Expiration
Failed Login Lock
Active Sessions
Force Logout

Optional:
IP Restriction

Permission change itself Audit شود.

==================================================
62. REPORTING ENGINE
==================================================

Almost every List can become a Report.

Features:

Search
Filter
Complex Filters
Group By
Multi-Level Group By
Aggregation
Saved Views
Shared Views
Export

--------------------------------
Filters
--------------------------------

Example:

Salesperson = Ali
AND
Amount > 1B
AND
Status = Completed

Support nested AND/OR.

--------------------------------
Date Filters
--------------------------------

Today
Yesterday
This Week
Last Week
This Month
Last Month
This Year
Last Year
Custom

Persian/Jalali UI.

--------------------------------
Group By
--------------------------------

Example:

Salesperson
→ Customer
→ Product
→ Month

--------------------------------
Aggregation
--------------------------------

SUM
COUNT
MIN
MAX
AVG

--------------------------------
Saved Views
--------------------------------

Example:

My Completed Sales This Month

visibility:

PRIVATE
TEAM
SHARED

Permission must still apply.

==================================================
63. GLOBAL SEARCH
==================================================

Ctrl+K.

Search:

Customer
Phone
Order Number
Purchase Number
Product
Invoice
Payment
File
Activity

Example:

09121234567
→ Customer

SO-1405-1050
→ Sales Order

RTX-...
→ Tax Product

Search result must respect Permission.

==================================================
64. COMMAND PALETTE
==================================================

Ctrl+K can also run Commands.

Example query:

new sale

Results:

New Sale
New Customer
New Price Request

Example:

payment

Results:

Register Receipt
Register Payment
Open Reconciliation

==================================================
65. DASHBOARD
==================================================

Home must be command center.

Components:

Module Shortcuts
My Work
Notifications
Approvals
Quick Actions
KPIs
Charts
Lists

Role-specific dashboards.

--------------------------------
Salesperson Dashboard
--------------------------------

My Customers
Pending Activities
Open Quotes
Monthly Sales
Tonnage
Monthly Profit if permitted
Ranking
Target
Commission

--------------------------------
Accountant Dashboard
--------------------------------

Unmatched Payments
Checks Due
Moadian Errors
Bank Balances
Pending Reconciliation
Approvals

--------------------------------
Dashboard Customization
--------------------------------

Manager defines Default Layout.

User may:

move widget
resize
hide
add

Reset to default.

==================================================
66. SALES PERFORMANCE
==================================================

Metrics per salesperson:

sales amount
tonnage
products sold
customer count
monthly profit
activities
ranking
target
commission

Target Rules configurable.

Example:

Target = 100 tons

If achieved:
Commission rate increases.

==================================================
67. SETTINGS
==================================================

Central Settings:

General
Company
Users
Security
Sales
Purchase
Products
Inventory
Accounting
Moadian
Notifications
SMS
Workflow
Automation
Templates
Sequences
Files
Integrations
Backup

Changes must be Audited.

==================================================
68. SETTINGS JSON IMPORT / EXPORT
==================================================

Allow section-based export.

Example:

Export:
Automation Rules
Workflow
Notification Rules
SMS Templates
Sequences

JSON Import must first show Preview:

34 new
12 updated
3 conflicts

Then user confirms.

Do NOT export:

passwords
API secrets
private keys
tokens
Moadian private credentials

==================================================
69. DOCUMENT NUMBERING / SEQUENCES
==================================================

Configurable Sequences:

Sales Document
Purchase
Sales Tax Invoice
Purchase Tax Invoice
Receipt
Payment
Check
Journal Entry
etc.

Format can change prospectively.

Existing Documents must NEVER renumber.

==================================================
70. QUEUE ENGINE
==================================================

Central Queue.

QueueJob:

id
queue_name
job_type
payload
priority
status
attempt_count
max_attempts
scheduled_at
started_at
finished_at
last_error
created_by

Statuses:

PENDING
SCHEDULED
PROCESSING
RETRYING
FAILED
SUCCEEDED
CANCELLED

Priorities:

CRITICAL
HIGH
NORMAL
LOW

Successful Jobs removed from active queue but History retained.

==================================================
71. RETRY / DEAD LETTER
==================================================

Each integration configurable Retry Policy.

After max retries:
Dead Letter Queue.

Error Center must show:

source
related entity
error
attempts
last attempt

Actions:

Retry
Cancel
Open Related Record
View Details

==================================================
72. INTEGRATION PLATFORM
==================================================

Adapters:

SMS
Telegram
WhatsApp
Eitaa
Bale
Rubika
Website
Moadian
Email
Future Connectors

Business Module must not call vendor SDK directly.

Use Interface/Adapter.

==================================================
73. PROVIDER FALLBACK
==================================================

Example SMS:

Primary Provider A
Backup Provider B

Config option:

Fallback on provider failure.

==================================================
74. API PLATFORM
==================================================

Secure API.

Auth
Permissions
Rate Limit
Audit
Versioning

Possible resources:

/api/customers
/api/products
/api/sales
/api/purchases
/api/prices

==================================================
75. CUSTOMER PORTAL API
==================================================

Website customer must be able to see his own data.

Initial linking can use verified mobile number.

Flow:

Website Login
→ OTP
→ Verified Mobile
→ normalize mobile
→ Party Match
→ Portal Account Link

Do NOT rely forever on raw mobile query.

Create:

customer_portal_accounts

Fields:

id
party_id
website_user_id
verified_mobile
status
created_at

--------------------------------
Mobile Normalization
--------------------------------

Example:

09121234567
+989121234567

must normalize to same canonical phone.

--------------------------------
Duplicate Phone Safety
--------------------------------

اگر یک شماره به چند Party وصل شد:

never expose all records automatically.

Require explicit resolution/linking.

--------------------------------
Portal Endpoints
--------------------------------

/api/portal/profile
/api/portal/orders
/api/portal/payments
/api/portal/loadings
/api/portal/balance
/api/portal/files

Only expose permitted customer data.

Never expose:

company profit
purchase price
supplier details
internal notes
internal audit
unauthorized driver information

Driver info follows Workflow approval.

==================================================
76. IMPORT / EXPORT ENGINE
==================================================

این Engine باید شبیه Odoo بسیار حرفه‌ای باشد.

تقریباً تمام Listهای اصلی:

Import
Export

داشته باشند.

Formats:

XLSX
CSV
JSON where appropriate

==================================================
77. IMPORT WIZARD
==================================================

Steps:

1. Upload
2. Detect columns
3. Map fields
4. Validate
5. Preview
6. Configure import mode
7. Start
8. Monitor progress
9. Review errors

--------------------------------
Saved Mapping
--------------------------------

Example:

"Customer Import From Parsian"

Column:
نام مشتری
→ Party.name

موبایل
→ Party.mobile

Mapping reusable باشد.

==================================================
78. LARGE IMPORT
==================================================

برای فایل‌های بزرگ Sync Request استفاده نکن.

مثال:

250,000 rows.

Process in chunks.

Default:
1000 rows per chunk

Jobs:

1-1000
1001-2000
2001-3000
...

Each chunk separate queue job.

==================================================
79. MANUAL IMPORT RANGE
==================================================

User can choose:

From Row:
50001

To Row:
75000

همچنین Batch Size قابل تنظیم باشد.

==================================================
80. IMPORT PROGRESS
==================================================

Example:

Total:
250,000

Processed:
77,000

Success:
76,800

Failed:
200

Remaining:
173,000

Buttons:

PAUSE
RESUME
CANCEL

If stopped:
continue from last safe checkpoint.

==================================================
81. IMPORT MODES
==================================================

CREATE_ONLY
UPDATE_EXISTING
CREATE_AND_UPDATE

Match Key configurable.

Party:

Mobile
National ID
Internal Code

Product:

SKU
Variant Code

==================================================
82. DUPLICATE HANDLING IN IMPORT
==================================================

Use CRM Duplicate Rules.

Exact mobile duplicate:
do not blindly create.

Options depending on permission/config:

Update Existing
Skip
Review

Similar Name:
Possible Duplicate.

==================================================
83. BATCH COMMIT
==================================================

Do not wrap 250,000 rows in one giant DB Transaction.

Each batch can commit independently.

If batch 78 fails:
previous batches remain.

==================================================
84. IMPORT ERROR EXPORT
==================================================

At end:

Success:
249,200

Failed:
800

Allow:

Download Failed Rows

File includes:

original columns
error_message

User fixes those rows and reimports.

==================================================
85. IMPORT HISTORY
==================================================

Keep history:

filename
entity
user
date
total
success
failed
status
mapping_used

Allow:

view errors
view mapping
download original if permitted

==================================================
86. EXPORT
==================================================

Export options:

Current Filtered Results
Selected Rows
All Allowed Records

Column chooser.

Saved Export Templates.

==================================================
87. LARGE EXPORT
==================================================

Large export async:

Export Requested
→ Queue
→ Generate File
→ Notification
→ Download Ready

No browser timeout.

==================================================
88. IMPORT / EXPORT PERMISSIONS
==================================================

Separate permissions:

Import Customers
Update Existing Customers
Import Accounting
Export Own Customers
Export All Customers
Export Financial Data

==================================================
89. FILE / DATA SECURITY
==================================================

Sensitive Export must be auditable.

Example:

User exported 20,000 customer phone numbers.

Log:

who
when
filters
row count
file id

==================================================
90. REAL-TIME UI
==================================================

Important changes should be pushed to UI.

Example:

Buyer enters supplier price.

Salesperson currently viewing Price Request sees update without reload.

Accountant rejects payment.

Salesperson immediately receives notification.

Use WebSocket/SSE where appropriate.

==================================================
91. DATA GRID
==================================================

Reusable high-performance Grid.

Features:

sort
filter
group
resize columns
reorder columns
hide/show
pin
multi-select
bulk actions
inline edit where safe

Keyboard support mandatory.

Sensitive/posted documents must not allow unsafe inline edits.

==================================================
92. KEYBOARD-FIRST UX
==================================================

All core flows must work without mouse.

Minimum shortcuts:

Ctrl+K → Search/Command Palette
Ctrl+S → Save
Esc → Close/Cancel dialog
Enter → Open/Confirm appropriate action
Tab → next field
Shift+Tab → previous
Arrow Keys → grid navigation
Space → select row

Build proper focus management.

When modal opens:
focus inside modal.

When modal closes:
focus returns to previous control.

==================================================
93. DESIGN SYSTEM
==================================================

Create shared components:

Button
Input
Select
Autocomplete
Date Picker
Jalali Date Picker
Modal
Drawer
Table
Data Grid
Tabs
Badge
Toast
Alert
Timeline
Command Palette
File Picker
Entity Selector
Money Input
Quantity Input
UOM Selector

Consistent behavior across entire ERP.

==================================================
94. BACKUP
==================================================

Backup:

Database
Files
Settings

Schedules:

Daily
Weekly
Manual

Retention configurable.

Backup Verification / Restore Test planned.

==================================================
95. FEATURE FLAGS
==================================================

Infrastructure for future capabilities.

Example:

FleetManagement = OFF
AdvancedWarehouse = OFF
CreditLimit = OFF

Do not implement unnecessary complexity now.

==================================================
96. DO NOT IMPLEMENT THESE MODULES FOR NOW
==================================================

Do NOT add unless I explicitly request later:

Sales Contract Module
Customer Credit Limit
Stock Reservation
Serial / Lot / Batch
Production / MRP
Fleet Management
Transportation Cost Calculation
Customer Delivery Confirmation
Overly complex generic Odoo-style pricing rules

Do not calculate Operational Profit from Tax Invoice.

Do not make Tax Invoice visible to ordinary Salesperson.

Do not require Price Request before Purchase.

Do not create separate Quotation and Sales Order tables/numbers.

==================================================
97. END-TO-END SALES EXAMPLE
==================================================

Implement the architecture so this scenario works:

Customer calls.

Opportunity created.

Customer asks:
50 tons rebar 16 Sirjan.

Salesperson creates Price Request.

Buyer receives request.

System shows today's known price if any.

Buyer receives offers:

Supplier A:
34,300

Supplier B:
34,450

Supplier C:
34,250

Supplier C marked daily lowest.

Salesperson creates quotation:

SD-1405-0105

Customer confirms.

Do NOT create another sales document.

SD-1405-0105 becomes Sales Order.

Price/quantity lock.

Purchase Document created.

Purchase and Sale linked.

Loading happens:

24.2 tons
24.3 tons

Actual:
48.5 tons.

Operational Sale/Purchase amounts calculated using business rules and actual loaded quantity.

Salesperson records:

Customer says 500M transferred.

Operational Payment Claim created:

UNMATCHED

Operational balance temporarily updated.

Accountant checks bank.

Case A:
payment found
→ MATCHED
→ Accounting Receipt generated/linked.

Case B:
payment not found
→ REJECTED
→ reason:
"مبلغ به حساب شرکت واریز نشده است."
→ customer's operational debt restored
→ notification to salesperson + manager
→ timeline event
→ audit.

Accountant creates Sales Tax Invoice.

Tax Invoice may use a Tax Product different from operational Product.

Tax Invoice may have different tax quantity/unit price from operational order.

Tax Invoice linked Many-to-Many to Sales Order.

Moadian:

Prevalidation
Queue
Submit
Receive Reference
Poll Status
SUCCESS

Sales Order header then shows:

Moadian:
Registered

Invoices:
1

Covered amount:
100%

If failed:
Order shows Moadian Error/Partial status.

==================================================
98. PURCHASE + MULTIPLE TAX INVOICE EXAMPLE
==================================================

Purchase Order PO-100:

100 tons product.

Could have:

Purchase Tax Invoice A:
30 tons equivalent amount

Purchase Tax Invoice B:
40 tons

Purchase Tax Invoice C:
30 tons

All linked to PO-100.

Also support one Tax Invoice linked to multiple Purchase Orders.

Same many-to-many concept in Sales.

==================================================
99. ACCOUNTING EXAMPLE
==================================================

Customer owes:
500,000,000

Customer pays:
500,000,000

Bank fee:
500,000

Journal:

Line 1:
Bank
Debit 499,500,000
Description:
یک فقره واریز به صادرات توسط مشتری

Line 2:
Bank Fee Expense
Debit 500,000
Description:
کارمزد انتقال وجه

Line 3:
Customer Receivable
Credit 500,000,000
Description:
دریافت از مشتری بابت ...

Debit Total must equal Credit Total.

==================================================
100. FINANCIAL RESPONSIBILITY EXAMPLE
==================================================

Party A debt:
500M

Party B debt:
300M

Party Ravan debt:
200M

A and B have:

financial_responsible_party = Ravan

Individual reports:

A = 500M
B = 300M
Ravan = 200M

Responsible Group report:

Ravan group total = 1B

Do not merge Party identities.

==================================================
101. NOTIFICATION EXAMPLE
==================================================

Event:
Payment Rejected

Rule:

Recipients:
record.salesperson
sales_manager

Channels:
IN_APP

Message:

"پرداخت ثبت‌شده برای سفارش SD-1405-0105 توسط حسابداری رد شد."

Reason:
"مبلغ به حساب شرکت واریز نشده است."

Click:
open Payment Claim / Sales Order.

==================================================
102. AUTOMATION EXAMPLE
==================================================

Rule:

Name:
Quotation Follow-Up

Trigger:
SalesDocument status changed to QUOTATION_SENT

Delay:
3 days

Condition:
SalesDocument status still not SALES_ORDER

Actions:

Create Activity:
"پیگیری پیش‌فاکتور"

Assign:
salesperson

Due:
today

Send In-App Notification.

If order becomes SALES_ORDER before 3 days:
cancel scheduled automation.

==================================================
103. WORKFLOW EXAMPLE
==================================================

Loading created.

Condition:

customer.outstanding_balance > 0

Then:

Create Approval Request:
"Release Driver Information"

Until Approved:

Customer Portal driver phone hidden.
Customer SMS driver phone omitted.

Manager approves.

Then:

driver phone becomes available
and optional SMS action may execute.

==================================================
104. IMPORT EXAMPLE
==================================================

User uploads:

customers.xlsx

Rows:
245,720

Mapping:

نام → Party Name
موبایل → Mobile
کد ملی → National Code
شهر → City

Validation result:

Valid:
244,900

Errors:
820

Start import.

Batch size:
1000.

Process asynchronously.

If system stops after 50,000 rows:

Resume from safe checkpoint.

User can alternatively choose:

Rows 50,001–75,000 only.

After finish:

Success:
244,700

Failed:
1,020

Generate:

failed_rows.xlsx

with:
error_message

==================================================
105. NON-FUNCTIONAL REQUIREMENTS
==================================================

Performance:

Use pagination/cursor pagination for large lists.

Do not load entire tables.

Indexes must be planned.

Search fields indexed.

Large imports use bulk operations.

Avoid N+1 queries.

Concurrency:

Use optimistic locking/version fields where needed.

Accounting posting must avoid duplicate posting.

Automation idempotent.

Queue jobs idempotent where possible.

Data Integrity:

Foreign keys.
Unique constraints.
Check constraints where useful.
Transactions around critical accounting operations.

Observability:

Structured logs.
Queue metrics.
Failed jobs.
Integration health.
Error tracking.

==================================================
106. DATABASE RULES
==================================================

Create proper normalized schema.

Do not overuse JSON columns for normal relational data.

JSON/JSONB is acceptable for:

external raw responses
automation configuration
workflow definitions where appropriate
settings values
metadata

but critical searchable business relations should be relational.

Use UUID or appropriate globally safe IDs.

Add indexes based on actual query patterns.

Use proper unique constraints.

Examples:

Normalized phone index.
Document number uniqueness per sequence/company.
Tax number uniqueness when required.

==================================================
107. MULTI-COMPANY READINESS
==================================================

حتی اگر فعلاً یک Company استفاده می‌شود، معماری را طوری طراحی کن که در آینده Multi-Company شدن غیرممکن نشود.

ولی UI/Business Logic نسخه اول را بی‌جهت پیچیده نکن.

Core records where necessary may include:

company_id

==================================================
108. MONEY / CURRENCY
==================================================

Default currency configurable.

Internal numeric storage Decimal.

Formatting configurable.

Do not store formatted monetary strings.

==================================================
109. LOCALIZATION
==================================================

Primary UI:
Persian RTL

Support English fields and future English UI.

Need:

RTL-safe layouts
Persian number formatting where appropriate
Jalali dates
Gregorian export option

Product/Brand/Attribute:
fa + en names.

==================================================
110. AUDIT REQUIREMENTS
==================================================

Audit important events:

customer changes
product changes
sale changes
purchase changes
confirmed document override
financial entries
payment rejection
workflow transitions
approval actions
Moadian attempts
permission changes
settings changes
imports
sensitive exports

Audit record should be immutable to regular users.

==================================================
111. IMPLEMENTATION APPROACH
==================================================

Do NOT try to generate thousands of random files without structure.

Proceed in phases.

PHASE 1
Architecture + Repository Setup

Create:

project structure
backend architecture
frontend architecture
database
Docker
environment configuration
authentication skeleton
shared UI system
logging
error model

PHASE 2
Foundation

Users
Roles
Permissions
Teams
Audit
Settings
Sequences
Files
Queue

PHASE 3
CRM + Product

Party
Contacts
Addresses
Customer Score
Products
Variants
Attributes
UOM
Brands
Suppliers

PHASE 4
Sales + Purchase + Price Request

Lead
Opportunity
SalesDocument
Purchase
PriceRequest
SupplierOffers
DocumentFlow

PHASE 5
Pricing + Publishing

Daily Pricing
Price History
Bulk Update
Publish Queue
Channel Adapters

PHASE 6
Loading + Inventory

Loading
Allocations
Stock Movement
Locations
Computed Stock

PHASE 7
Accounting

Chart of Accounts
Fiscal Years
Journals
Journal Entries
Receipt/Payment
Operational Payment Claims
Bank
Reconciliation
Checks
Opening Balances
Financial Responsibility

PHASE 8
Tax Invoices + Moadian

SalesTaxInvoice
PurchaseTaxInvoice
Tax Product
Moadian Submission
Inquiry
Errors
Purchase Inbox
Many-to-Many Invoice ↔ Order

PHASE 9
Activities + Workflow + Automation

Activity
Calendar
Workflow
Approval
Automation
Notification
SMS

PHASE 10
Reports + Dashboard + Search

Reporting
Saved Views
Group By
Global Search
Command Palette
Dashboard Widgets

PHASE 11
API + Portal + Import/Export

Customer Portal API
Website Integration
Import Wizard
Chunk Processing
Large Export

PHASE 12
Hardening

Tests
Security
Performance
Database Index Review
Queue Reliability
Backup
Monitoring
Permissions Review
Accounting Tests

==================================================
112. YOUR RESPONSE / WORKING RULES
==================================================

From this point forward, behave like the lead engineer responsible for shipping this application.

Important:

1.
Do not silently change any business rule written above.

2.
If you think a rule has a technical problem, explain the issue before changing it.

3.
Do not simplify important accounting or workflow rules just to make coding easier.

4.
Do not add major modules that were explicitly excluded.

5.
When a feature requires an external credential such as Moadian/SMS/Telegram, build the adapter/interface and mock/test provider so development can continue without credentials.

6.
Do not use fake placeholder implementations for core business logic.

7.
Every database migration must be safe and understandable.

8.
Write clean names and comments.

9.
Avoid giant God Classes.

10.
Separate Domain, Application and Infrastructure responsibilities.

11.
Use DTO/schema validation.

12.
Return proper API error codes.

13.
Implement optimistic concurrency where concurrent edits may be dangerous.

14.
Write tests alongside critical financial/business logic.

15.
For every module, include:
database schema
backend services
API
permissions
audit events
frontend list
frontend form
validation
tests

16.
Every important list should support:
pagination
search
filter
sort
permission-aware queries

17.
Do not ask me to manually recreate trivial boilerplate if you can create it yourself.

18.
When coding, show exactly which files are being created or changed.

19.
After each milestone:
run lint
run typecheck
run tests
run database validation/build

and fix errors before continuing.

20.
Keep a PROJECT_PROGRESS.md file.

It must contain:

completed modules
current module
pending modules
important architectural decisions
known issues
next steps

This prevents losing context in future sessions.

==================================================
113. FIRST TASK
==================================================

Start the project now.

Do NOT begin by implementing random pages.

First do the following:

A)
Analyze all requirements above.

B)
Create a clear Domain Map showing all bounded contexts/modules.

C)
Create the initial ERD including the most important entities and relationships.

At minimum show:

Party
PartyRole
Contact
Address
User
Role
Permission
Team
ProductTemplate
ProductVariant
Attribute
AttributeValue
UOM
SupplierProduct
Lead
Opportunity
SalesDocument
SalesLine
PurchaseDocument
PurchaseLine
SalesPurchaseAllocation
PriceRequest
PriceRequestLine
SupplierOffer
DailyPrice
Loading
LoadingAllocation
Warehouse/Location
StockMovement
TaxProduct
SalesTaxInvoice
SalesTaxInvoiceLine
PurchaseTaxInvoice
PurchaseTaxInvoiceLine
TaxInvoiceOrderAllocation
ChartOfAccount
FiscalYear
Journal
JournalEntry
JournalLine
OperationalPaymentClaim
Receipt
Payment
BankAccount
Check
Reconciliation
FinancialResponsibility
Activity
WorkflowDefinition
WorkflowState
WorkflowTransition
ApprovalRequest
AutomationRule
AutomationRun
Notification
NotificationRule
SmsTemplate
File
FileAttachment
AuditLog
QueueJob
IntegrationConfig
Setting
Sequence
ImportJob
ImportBatch
ExportJob
PortalAccount

D)
Specify cardinalities.

Examples:

Party 1:N Addresses
ProductTemplate 1:N Variants
SalesDocument 1:N SalesLines
Sales ↔ Purchases M:N
SalesOrder ↔ SalesTaxInvoice M:N
PurchaseOrder ↔ PurchaseTaxInvoice M:N

E)
Identify indexes and unique constraints.

F)
Create project folder structure.

G)
Initialize the actual codebase.

H)
Configure PostgreSQL, Redis and file storage for local development.

I)
Implement the foundation first.

J)
Do not stop at writing documentation. After architecture is established, begin creating the actual application.

==================================================
114. ACCEPTANCE STANDARD
==================================================

I do not consider a module complete because a UI page exists.

A module is complete only when:

database exists
migrations exist
backend works
permissions work
audit works
validation works
frontend works
keyboard operation works where relevant
errors are handled
tests exist
module integrates with related modules

For accounting-sensitive modules, automated tests are mandatory.

For example:

Journal Entry where debit != credit:
must fail.

Duplicate posting:
must fail.

Payment Reject:
must correctly restore operational balance.

Confirmed Sales price edit without permission:
must fail at backend.

Unauthorized Portal customer accessing another customer's order:
must return forbidden/not found.

Duplicate Automation Event:
must not send duplicate SMS.

Large Import:
must resume safely after interruption.

Moadian retry:
must preserve previous attempts.

==================================================
115. FINAL DEVELOPMENT PRINCIPLE
==================================================

Build this as a long-term enterprise application, not a demo.

Priorities, in order:

1. Correct business logic
2. Data integrity
3. Accounting correctness
4. Security
5. Auditability
6. Performance
7. UX speed
8. Keyboard usability
9. Maintainability
10. Visual polish

Whenever you must choose between a quick shortcut and a correct scalable architecture, use the correct architecture unless it creates unnecessary complexity for a feature explicitly excluded above.

Now begin with:
Domain Map
→ ERD
→ repository architecture
→ database foundations
→ actual implementation.
==================================================
116. CORRECTION LOG (2026-10-06) — Architecture Correction Gate
==================================================

The following 15 corrections were ratified at the Architecture Correction Gate and are
ALREADY IMPLEMENTED in `apps/backend/prisma/schema.prisma` and migrations
`20241006000000_correction_gate` + `20241006120000_party_operational_balance`.
They SUPERSEDE any conflicting statement elsewhere in this specification
(e.g. the original BankTransaction naming, the generic tax-invoice allocation table,
the single-company deferral, and the BullMQ-vs-PostgreSQL queue clarification).

1. MULTI-COMPANY FROM DAY ONE: new `Company` entity (id, name_fa, name_en, national_id,
   economic_code, status) + `UserCompany` membership (user<->company M:N with is_default).
   Users carry `default_company_id`. Mandatory company scope on: Team, Setting
   (UNIQUE(company_id, key)), Sequence (UNIQUE(company_id, document_type)),
   IntegrationConfig (UNIQUE(company_id, code)), NotificationRule (UNIQUE(company_id, code));
   nullable scope (null = platform-level) on QueueJob and AuditLog. Roles/Permissions remain
   system-level; company-specific role bindings are supported through UserCompany. All
   natural unique constraints are company-scoped.

2. NO standalone BankTransaction source of truth. Treasury sources: Receipt, Payment,
   BankTransfer, Incoming Check Clearing, Outgoing Check Payment, and Bank Adjustment
   (later, permission-sensitive). `BankStatementLine` is a NON-source ledger for daily
   ordering / sequence_no / running_balance / reconciliation / source links with fields:
   company_id, bank_account_id, entry_date, sequence_no, direction (DEPOSIT/WITHDRAWAL),
   amount, running_balance, reference_number, description, source_entity_type,
   source_entity_id, journal_entry_id, is_reconciled. UNIQUE(company_id, bank_account_id,
   entry_date, sequence_no). Gapless numbering is NOT required; deterministic ordering is.

3. `OperationalSettlementClaim` replaces the sale-only OperationalPaymentClaim:
   direction CUSTOMER_RECEIPT (requires sales_document_id) / SUPPLIER_PAYMENT (requires
   purchase_document_id); party always set; statuses UNMATCHED/MATCHED/REJECTED; no bank
   effect until matched; REJECTED restores the operational balance (new
   `PartyOperationalBalance` table with optimistic version) + audit + timeline + notification.

4. Split tax allocation tables: `SalesTaxInvoiceOrderAllocation` (sales_tax_invoice_id,
   sales_document_id, allocated_amount, allocated_quantity?, UNIQUE pair) and
   `PurchaseTaxInvoiceOrderAllocation` (same pattern). No generic polymorphic allocation.

5. Loading = header + `LoadingLine` (product_variant_id, actual_quantity, uom_id, notes) +
   `LoadingAllocation` (loading_line_id, sales_line_id?/purchase_line_id?,
   allocated_quantity). One loading is registered once and shown on both sale and
   purchase sides.

6. SupplierProduct is genuinely three-level: mapping_level VARIANT|TEMPLATE|CATEGORY with
   exactly one FK set (enforced by a DB CHECK constraint).

7. `WorkflowTimer` runtime entity: workflow_instance_id, state_id, timer_type
   (ESCALATION/REMINDER/TIMEOUT), due_at, status (SCHEDULED/EXECUTED/CANCELLED/FAILED),
   action_config, executed_at. Owned by the Workflow engine; executed via the queue.
   Minimal WorkflowDefinition/WorkflowState/WorkflowInstance tables exist now.

8. NotificationRule completed: company_id, code, event, conditions (JSON, nested all/any),
   recipient_config, channels, delay_config, priority, enabled.

9. Queue architecture clarified: BullMQ/Redis = runtime queue/scheduling/retry execution;
   PostgreSQL QueueJob + JobExecution = durable business history, status, audit,
   idempotency. QUEUE_DRIVER=auto falls back to DB polling when Redis is unavailable.

10. Sequence engine v2: company_id, document_type, prefix, padding, reset_cycle
    (NEVER|FISCAL_YEAR|JALALI_YEAR|MONTHLY), current_number, last_reset_marker;
    concurrency-safe FOR UPDATE allocation; history is never renumbered.

11. TaxDefinition: company-scoped, immutable after first use (a rate change creates a new
    row); invoice lines carry tax_definition_id + tax_rate_snapshot (Phase 8 columns on
    invoice lines).

12. Accounting foundation: ChartOfAccount, JournalEntry (DRAFT/POSTED/REVERSED/CANCELLED;
    posted entries are never edited or deleted — reverse instead), JournalLine (debit >= 0,
    credit >= 0, never both positive — DB CHECK; SUM(debit) == SUM(credit) enforced inside
    the POST transaction), BankAccount, Check (direction-specific lifecycle: incoming
    REGISTERED -> PENDING -> DEPOSITED -> CLEARED/BOUNCED/CANCELLED, outgoing
    REGISTERED -> PENDING -> PAID/BOUNCED/CANCELLED; bank effect ONLY on CLEARED/PAID),
    BankTransfer rule: Dr Destination X, Dr Bank Fee Expense F, Cr Source X+F; statement
    lines: source WITHDRAWAL X+F + destination DEPOSIT X. Invoices NEVER touch bank directly.

13. PortalAccount: company_id, party_id, website_user_id, verified_mobile, status — the
    verified mobile is used ONLY for initial linking; an ambiguous mobile exposes nothing
    automatically.

14. Security: the seed admin password comes only from SEED_ADMIN_USERNAME /
    SEED_ADMIN_PASSWORD environment variables; no default credentials in the README;
    production startup rejects known default passwords.

15. GRAPHIFY (option B): `graphify-out/` is git-ignored; graph artifacts (graph.html,
    graph.json, GRAPH_REPORT.md) are local-only and auto-rebuilt by a git post-commit hook
    (AST-only). Graphify supports navigation but never replaces tests or architecture
    review. The rules live in AGENTS.md.
