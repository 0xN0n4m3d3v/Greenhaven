-- Spec 140: pre-generated first-entry bubbles for every playable place.
--
-- 0086 created location_intro_bubbles, but many non-English rows were only
-- English summaries copied under a translated language key. This fix-forward
-- migration makes the table complete and language-real:
--   * every location/district gets one row per supported UI language;
--   * localized summaries are used only when the cartridge actually has one;
--   * otherwise a short, diegetic, language-specific first-entry line is used;
--   * the row source is marked so later cartridge authoring can replace it.

WITH supported_lang(lang) AS (
  VALUES
    ('en'), ('ru'), ('uk'), ('bg'), ('sr'), ('es'), ('fr'), ('de'), ('it'),
    ('pt'), ('ro'), ('he'), ('ar'), ('fa'), ('ur'), ('hi'), ('mr'), ('ne'),
    ('bn'), ('th'), ('el'), ('hy'), ('ka'), ('ko'), ('ja'), ('zh')
),
localized AS (
  SELECT
    e.id AS location_entity_id,
    l.lang,
    COALESCE(NULLIF(e.i18n->'display_name'->>l.lang, ''), e.display_name) AS name,
    CASE
      WHEN l.lang = 'en' THEN COALESCE(NULLIF(e.i18n->'summary'->>'en', ''), e.summary)
      ELSE NULLIF(e.i18n->'summary'->>l.lang, '')
    END AS localized_summary
  FROM entities e
  CROSS JOIN supported_lang l
  WHERE e.kind IN ('location', 'district')
),
rendered AS (
  SELECT
    location_entity_id,
    lang,
    '@' || name ||
    CASE lang
      WHEN 'en' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'First entry. Pause at the threshold: note who is here, what is visible, where the exits lead, and which hook asks for attention first.'
      WHEN 'ru' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'Первый вход. Задержись на пороге: отметь, кто здесь, что лежит на виду, куда ведут выходы и какая зацепка просится первой.'
      WHEN 'uk' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'Перший вхід. Затримайся на порозі: відміть, хто тут, що видно, куди ведуть виходи і яка зачіпка проситься першою.'
      WHEN 'bg' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'Първо влизане. Спри на прага: отбележи кой е тук, какво се вижда, накъде водят изходите и коя следа иска внимание първа.'
      WHEN 'sr' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'Први улазак. Застани на прагу: забележи ко је овде, шта је на видику, куда воде излази и који траг први тражи пажњу.'
      WHEN 'es' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'Primera entrada. Detente en el umbral: observa quién está aquí, qué queda a la vista, adónde llevan las salidas y qué pista pide atención primero.'
      WHEN 'fr' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'Première entrée. Arrête-toi au seuil : repère qui est là, ce qui se voit, où mènent les sorties et quelle piste appelle d’abord.'
      WHEN 'de' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'Erster Eintritt. Halte an der Schwelle inne: erkenne, wer hier ist, was sichtbar liegt, wohin die Ausgänge führen und welcher Hinweis zuerst zählt.'
      WHEN 'it' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'Primo ingresso. Fermati sulla soglia: nota chi è qui, cosa si vede, dove portano le uscite e quale indizio chiede attenzione per primo.'
      WHEN 'pt' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'Primeira entrada. Pare na soleira: observe quem está aqui, o que está à vista, para onde levam as saídas e qual pista pede atenção primeiro.'
      WHEN 'ro' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'Prima intrare. Oprește-te în prag: observă cine este aici, ce se vede, unde duc ieșirile și ce indiciu cere primul atenție.'
      WHEN 'he' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'כניסה ראשונה. עצור בפתח: שים לב מי כאן, מה גלוי לעין, לאן מובילות היציאות ואיזה רמז דורש תשומת לב ראשון.'
      WHEN 'ar' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'الدخول الأول. توقّف عند العتبة: لاحظ من هنا، ما الظاهر للعين، إلى أين تقود المخارج، وأي خيط يستحق الانتباه أولاً.'
      WHEN 'fa' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'ورود نخست. روی آستانه مکث کن: ببین چه کسی اینجاست، چه چیزی پیداست، خروجی‌ها به کجا می‌روند و کدام سرنخ اول توجه می‌خواهد.'
      WHEN 'ur' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'پہلی آمد۔ دہلیز پر رک کر دیکھو: یہاں کون ہے، کیا صاف دکھائی دے رہا ہے، راستے کہاں جاتے ہیں، اور کون سا اشارہ پہلے توجہ چاہتا ہے۔'
      WHEN 'hi' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'पहला प्रवेश। दहलीज़ पर ठहरो: देखो यहाँ कौन है, क्या दिखाई दे रहा है, निकास कहाँ जाते हैं, और कौन-सा सुराग पहले ध्यान माँगता है।'
      WHEN 'mr' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'पहिला प्रवेश. उंबरठ्यावर थांब: इथे कोण आहे, काय दिसते, बाहेरचे मार्ग कुठे जातात आणि कोणता धागा आधी लक्ष मागतो ते पाहा.'
      WHEN 'ne' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'पहिलो प्रवेश। ढोकामै रोकिएर हेर: यहाँ को छ, के देखिन्छ, निकास कहाँ जान्छन्, र कुन संकेतले पहिले ध्यान माग्छ।'
      WHEN 'bn' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'প্রথম প্রবেশ। দোরগোড়ায় থামো: এখানে কে আছে, কী দেখা যাচ্ছে, বেরোনোর পথ কোথায় যায়, আর কোন সূত্র আগে নজর চায় তা দেখো।'
      WHEN 'th' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'เข้าครั้งแรก หยุดที่ธรณีประตู: สังเกตว่าใครอยู่ที่นี่ อะไรเห็นได้ชัด ทางออกพาไปไหน และเบาะแสใดควรสนใจก่อน'
      WHEN 'el' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'Πρώτη είσοδος. Στάσου στο κατώφλι: δες ποιος είναι εδώ, τι φαίνεται, πού οδηγούν οι έξοδοι και ποιο ίχνος ζητά πρώτο προσοχή.'
      WHEN 'hy' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'Առաջին մուտք։ Կանգնիր շեմին՝ նկատիր ով է այստեղ, ինչ է երևում, ուր են տանում ելքերը և որ հետքն է առաջինը ուշադրություն պահանջում։'
      WHEN 'ka' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        'პირველი შესვლა. ზღურბლთან შეჩერდი: ნახე ვინ არის აქ, რა ჩანს, სად მიდის გასასვლელები და რომელი კვალი ითხოვს პირველ ყურადღებას.'
      WHEN 'ko' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        '첫 방문. 문턱에서 멈춰 보라: 누가 있는지, 무엇이 보이는지, 출구가 어디로 이어지는지, 어떤 단서가 먼저 눈길을 끄는지 살펴라.'
      WHEN 'ja' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        '初めての入場。入口で足を止めよう。誰がいるか、何が見えるか、出口はどこへ続くか、最初に注目すべき手がかりは何かを見る。'
      WHEN 'zh' THEN ' — ' || COALESCE(localized_summary || ' ', '') ||
        '初次进入。先在门口停下：看清谁在这里、什么摆在眼前、出口通向哪里，以及哪条线索最值得先关注。'
      ELSE ' — ' || COALESCE(localized_summary || ' ', '') ||
        'First entry. Pause at the threshold: note who is here, what is visible, where the exits lead, and which hook asks for attention first.'
    END AS bubble_text
  FROM localized
  WHERE trim(name) <> ''
)
INSERT INTO location_intro_bubbles (
  location_entity_id,
  lang,
  bubble_text,
  source,
  updated_at
)
SELECT
  location_entity_id,
  lang,
  bubble_text,
  'generated_location_first_entry_v1',
  now()
FROM rendered
ON CONFLICT (location_entity_id, lang) DO UPDATE SET
  bubble_text = EXCLUDED.bubble_text,
  source = EXCLUDED.source,
  updated_at = now();
