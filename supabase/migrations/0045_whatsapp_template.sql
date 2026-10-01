-- Orders are now paid online before they reach the kitchen, so the default WhatsApp message
-- to a customer no longer asks them to "confirm". Owner can still edit it in Settings.
update business_settings set default_whatsapp_message =
  'Hi {name}, this is Pharaoh''s Bites about your order {order_number}. Your total is {total} (delivery {delivery_fee}). Thank you for ordering!';
alter table business_settings alter column default_whatsapp_message set default
  'Hi {name}, this is Pharaoh''s Bites about your order {order_number}. Your total is {total} (delivery {delivery_fee}). Thank you for ordering!';
