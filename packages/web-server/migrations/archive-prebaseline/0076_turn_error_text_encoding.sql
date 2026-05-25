-- 0076_turn_error_text_encoding.sql
-- Normalize known player-facing mojibake error text from pre-116 builds.

UPDATE chat_messages
   SET text = 'На мгновение мир замирает: действие не удалось обработать. Повтори намерение или выбери видимый переход.'
 WHERE (
        text LIKE '%Ð¼Ð³Ð½%' AND text LIKE '%Ð´ÐµÐ¹%'
       )
    OR (
        text LIKE 'Ã%' AND text LIKE '%Â¼%' AND text LIKE '%Â´%'
       );

UPDATE gui_events
   SET payload = jsonb_set(
     payload,
     '{message}',
     to_jsonb('Соединение с моделью прервано - повтори ход. (model TLS stream reset)'::text),
     true
   )
 WHERE event_type = 'turn.error'
   AND (
        payload ->> 'message' LIKE '%TLS stream reset%'
        OR payload ->> 'message' LIKE '%Ð¡Ð¾ÐµÐ´%'
       );

UPDATE gui_events
   SET payload = jsonb_set(
     payload,
     '{message}',
     to_jsonb('Запрос отменён.'::text),
     true
   )
 WHERE event_type = 'turn.error'
   AND payload ->> 'message' LIKE '%Ð—Ð°Ð¿Ñ€Ð¾Ñ%';

UPDATE gui_events
   SET payload = jsonb_set(
     payload,
     '{message}',
     to_jsonb('Модель не успела ответить - повтори ход.'::text),
     true
   )
 WHERE event_type = 'turn.error'
   AND payload ->> 'message' LIKE '%ÐœÐ¾Ð´ÐµÐ»ÑŒ%';

UPDATE gui_events
   SET payload = jsonb_set(
     payload,
     '{message}',
     to_jsonb('Провайдер модели ограничил запросы - подожди пару секунд и повтори.'::text),
     true
   )
 WHERE event_type = 'turn.error'
   AND payload ->> 'message' LIKE '%Ð¾Ð³Ñ€Ð°Ð½Ð¸Ñ‡%';

UPDATE gui_events
   SET payload = jsonb_set(
     payload,
     '{message}',
     to_jsonb('Провайдер модели недоступен - повтори ход.'::text),
     true
   )
 WHERE event_type = 'turn.error'
   AND payload ->> 'message' LIKE '%Ð½ÐµÐ´Ð¾ÑÑ‚%';
