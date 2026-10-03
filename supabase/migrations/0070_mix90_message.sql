-- 0070_mix90_message.sql : new welcome wording for MIX90 (2026-10-02)
update promo_codes set welcome_message = 'Welcome, Mix90! 💛 Thank you for being our customer. Your delivery is on us. Enjoy every bite!'
where code = 'MIX90';
