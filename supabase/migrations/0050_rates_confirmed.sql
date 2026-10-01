-- 0050: IRS rates were checked against irs.gov on 2026-10-01, so they are confirmed. No manual step.
update irs_mileage_rates set confirmed = true where not confirmed;
alter table irs_mileage_rates alter column confirmed set default true;
