# Catalogue and blocked items

Rulings for a tenant's products and Medora's block rules (PRD ADM-02, PHA-06; ADRs 0007, 0009 and 0023 set the rules). The web app's rulings for the same screens continue the ids in its own copy of this file.

### CAT1. A product is a medicine, a device or a service, with one price, and a medicine says what it is

Decision: `operational.products` holds a tenant's products: name, kind (`medicine`, `device`, `service`), schedule (S2, S3, S4 or S8 for a scheduled medicine; none when unscheduled), ARTG number, the compounded mark, strength, form, pack size, storage (room or refrigerated), one price in cents and whether it is GST-free. A medicine must carry an ARTG number or the compounded mark; only a medicine has a schedule or the compounded mark. The API refuses otherwise, and the database checks the same. ARTG numbers are kept as digits, however they were typed. One price per product per tenant for now. A product the tenant stops selling is archived, never deleted, so orders and scripts that name it keep their meaning; archiving can be undone.
Why: a block on an ARTG number or on compounding would be dodged by leaving the field blank, and a product row is what orders, invoices and scripts point at for years.
Decided by: stand-in (Fable 5.2), to confirm with Vahid. For the owner: whether prices need to vary by brand, and whether tenant-typed schedules and ARTG numbers must be checked against a medicines reference (the ARTG, or Parchment's) before the first patient. Until then a tenant that types an S8 medicine as S4 gets past an S8 rule.

### CAT2. Medora's block rules are data, added by platform staff and retired only by a reviewed script

Decision: `platform.block_rules` holds the rules no tenant may sell around. A rule matches a schedule, an ARTG number or the compounded mark, and carries a reason, an optional source link and the time it takes effect (now, or later to give tenants notice). Platform staff add one through the reviewed function `platform.add_block_rule`, which checks the flag again and writes an audit entry that belongs to no tenant. No route retires a rule: that takes a reviewed operator script that sets `retired_at`, so tightening is fast and loosening is slow. Rules are never named in code or migrations (ADR 0023); the launch list is loaded by an operator and reviewed as a launch gate. Ingredient-class rules wait until Medora holds its own ingredient list, because a class matched against text a tenant typed is not a block.
Why: ADR 0009 says blocked products stay blocked and tenants can't weaken it; a rule as data can be added the day a regulator acts, without a release.
Decided by: stand-in (Fable 5.2), to confirm with Vahid. For the owner: the launch list. Proposed: S8 medicines and compounded medicines; open: whether any S4 classes (benzodiazepines, testosterone and anabolic steroids, nicotine vapes, cannabidiol) join it once ingredient classes exist.

### CAT3. A product is checked when it is used, not only when it is saved

Decision: whether a product is blocked is worked out each time it is read, from the rules in force at that moment. The catalogue's front door gives other modules `getOrderableProduct(tx, productId)`, whose `blocked` is `{ code: 'platform_rule' | 'tenant_block', reason, ruleId }` or null, and `assertProductSuppliable(tx, productId)`, which answers the product or throws 409 `product_blocked` or `product_archived`. Prescribing, orders and billing call one of them every time, so a rule added today stops products made last year at once. A Medora rule shows before the tenant's own block when both apply.
Why: a block checked only when a product is saved leaves every existing product sellable after a new rule, which is exactly when it matters.
Decided by: stand-in (Fable 5.2), to confirm with Vahid. For the owner: what happens to an order already paid but not yet supplied when a rule lands. Proposed: the orders module sends it to review rather than cancelling it silently.

### CAT4. A tenant can block its own product, and lift its own block, never Medora's

Decision: a tenant with `catalogue:manage` blocks one of its products with a reason (a recall, a supplier problem) and can lift it again. The block only adds: lifting it leaves any matching Medora rule in place, and the reply's `blocked` says so.
Why: tenants need a fast stop of their own, and the way back out, without any path around the platform's rules.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### CAT5. Everyone in a tenant reads the catalogue; owner, admin and operations change it

Decision: `catalogue:read` goes to every starting role and `catalogue:manage` to owner, admin and operations. Both are operational-zone permissions. A price change writes an audit entry with the price before and after. No agent gets a tool that changes products or prices. Medora's block rules are readable by everyone signed in, since every tenant needs to know them before adding a product.
Why: it is operational data everyone needs to see, and few people should be able to change a price.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.
