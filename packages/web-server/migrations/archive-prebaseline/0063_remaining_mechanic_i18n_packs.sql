-- Spec 110 - remaining short mechanic labels across supported languages.
-- Loading quotes are intentionally left for a separate lore-authoring pass.

WITH packs(lang, entries) AS (
  VALUES
  ('uk', jsonb_build_object(
    'combat_state.active','Активний','combat_state.downed','Збитий','combat_state.stable','Стабільний','combat_state.dead','Мертвий',
    'condition.bleeding','Кровотеча','condition.stunned','Оглушений','condition.prone','На землі','condition.charmed','Зачарований','condition.frightened','Наляканий','condition.poisoned','Отруєний','condition.exhausted','Виснажений','condition.restrained','Стриманий','condition.off-balance','Втратив рівновагу',
    'item.oil_flask','Фляга олії','item.healing_potion','Зілля лікування','item.torch','Смолоскип','item.shortsword','Короткий меч','item.water_skin','Бурдюк з водою','item.rope_50ft','Мотузка 15 м',
    'string_band.hostile','Ворожий','string_band.wary','Насторожений','string_band.neutral','Нейтральний','string_band.friendly','Дружній','string_band.trusted','Довіряє','string_band.bonded','Повязаний',
    'surface.fire','Вогонь','surface.oil','Олія','surface.water','Вода','surface.ice','Лід','surface.electric','Електрика','surface.poison','Отрута','surface.blood','Кров','surface.smoke','Дим','surface.steam','Пара','surface.acid','Кислота','surface.web','Павутина','surface.lava','Лава',
    'trauma.first_time','Перший раз','trauma.betrayed','Зраджений','trauma.witnessed_death','Бачив смерть','trauma.violated','Скривджений','trauma.abandoned','Покинутий','trauma.humiliated','Принижений'
  )),
  ('bg', jsonb_build_object(
    'combat_state.active','Активен','combat_state.downed','Повален','combat_state.stable','Стабилен','combat_state.dead','Мъртъв',
    'condition.bleeding','Кървене','condition.stunned','Зашеметен','condition.prone','На земята','condition.charmed','Очарован','condition.frightened','Уплашен','condition.poisoned','Отровен','condition.exhausted','Изтощен','condition.restrained','Ограничен','condition.off-balance','Извън равновесие',
    'item.oil_flask','Флакон с масло','item.healing_potion','Лечебна отвара','item.torch','Факел','item.shortsword','Къс меч','item.water_skin','Мях с вода','item.rope_50ft','Въже 15 м',
    'string_band.hostile','Враждебен','string_band.wary','Предпазлив','string_band.neutral','Неутрален','string_band.friendly','Приятелски','string_band.trusted','Доверен','string_band.bonded','Свързан',
    'surface.fire','Огън','surface.oil','Масло','surface.water','Вода','surface.ice','Лед','surface.electric','Електричество','surface.poison','Отрова','surface.blood','Кръв','surface.smoke','Дим','surface.steam','Пара','surface.acid','Киселина','surface.web','Паяжина','surface.lava','Лава',
    'trauma.first_time','Първи път','trauma.betrayed','Предаден','trauma.witnessed_death','Видял смърт','trauma.violated','Наранен','trauma.abandoned','Изоставен','trauma.humiliated','Унижен'
  )),
  ('sr', jsonb_build_object(
    'combat_state.active','Активан','combat_state.downed','Оборен','combat_state.stable','Стабилан','combat_state.dead','Мртав',
    'condition.bleeding','Крварење','condition.stunned','Ошамућен','condition.prone','На земљи','condition.charmed','Очаран','condition.frightened','Уплашен','condition.poisoned','Отрован','condition.exhausted','Исцрпљен','condition.restrained','Спутан','condition.off-balance','Избачен из равнотеже',
    'item.oil_flask','Боца уља','item.healing_potion','Напитак лечења','item.torch','Бакља','item.shortsword','Кратки мач','item.water_skin','Мешина за воду','item.rope_50ft','Уже 15 м',
    'string_band.hostile','Непријатељски','string_band.wary','Опрезан','string_band.neutral','Неутралан','string_band.friendly','Пријатељски','string_band.trusted','Од поверења','string_band.bonded','Везан',
    'surface.fire','Ватра','surface.oil','Уље','surface.water','Вода','surface.ice','Лед','surface.electric','Струја','surface.poison','Отров','surface.blood','Крв','surface.smoke','Дим','surface.steam','Пара','surface.acid','Киселина','surface.web','Паутина','surface.lava','Лава',
    'trauma.first_time','Први пут','trauma.betrayed','Издан','trauma.witnessed_death','Видео смрт','trauma.violated','Повређен','trauma.abandoned','Напуштен','trauma.humiliated','Понижен'
  )),
  ('es', jsonb_build_object(
    'combat_state.active','Activo','combat_state.downed','Derribado','combat_state.stable','Estable','combat_state.dead','Muerto',
    'condition.bleeding','Sangrando','condition.stunned','Aturdido','condition.prone','Tumbado','condition.charmed','Encantado','condition.frightened','Asustado','condition.poisoned','Envenenado','condition.exhausted','Agotado','condition.restrained','Restringido','condition.off-balance','Desequilibrado',
    'item.oil_flask','Frasco de aceite','item.healing_potion','Poción curativa','item.torch','Antorcha','item.shortsword','Espada corta','item.water_skin','Odre de agua','item.rope_50ft','Cuerda 15 m',
    'string_band.hostile','Hostil','string_band.wary','Receloso','string_band.neutral','Neutral','string_band.friendly','Amistoso','string_band.trusted','Confiado','string_band.bonded','Vinculado',
    'surface.fire','Fuego','surface.oil','Aceite','surface.water','Agua','surface.ice','Hielo','surface.electric','Electricidad','surface.poison','Veneno','surface.blood','Sangre','surface.smoke','Humo','surface.steam','Vapor','surface.acid','Ácido','surface.web','Telaraña','surface.lava','Lava',
    'trauma.first_time','Primera vez','trauma.betrayed','Traicionado','trauma.witnessed_death','Vio muerte','trauma.violated','Violentado','trauma.abandoned','Abandonado','trauma.humiliated','Humillado'
  )),
  ('fr', jsonb_build_object(
    'combat_state.active','Actif','combat_state.downed','À terre','combat_state.stable','Stable','combat_state.dead','Mort',
    'condition.bleeding','Saignement','condition.stunned','Étourdi','condition.prone','À terre','condition.charmed','Charmé','condition.frightened','Effrayé','condition.poisoned','Empoisonné','condition.exhausted','Épuisé','condition.restrained','Entravé','condition.off-balance','Déséquilibré',
    'item.oil_flask','Flasque dhuile','item.healing_potion','Potion de soin','item.torch','Torche','item.shortsword','Épée courte','item.water_skin','Outre deau','item.rope_50ft','Corde 15 m',
    'string_band.hostile','Hostile','string_band.wary','Méfiant','string_band.neutral','Neutre','string_band.friendly','Amical','string_band.trusted','Confiant','string_band.bonded','Lié',
    'surface.fire','Feu','surface.oil','Huile','surface.water','Eau','surface.ice','Glace','surface.electric','Électricité','surface.poison','Poison','surface.blood','Sang','surface.smoke','Fumée','surface.steam','Vapeur','surface.acid','Acide','surface.web','Toile','surface.lava','Lave',
    'trauma.first_time','Première fois','trauma.betrayed','Trahi','trauma.witnessed_death','Mort vue','trauma.violated','Violenté','trauma.abandoned','Abandonné','trauma.humiliated','Humilié'
  )),
  ('de', jsonb_build_object(
    'combat_state.active','Aktiv','combat_state.downed','Am Boden','combat_state.stable','Stabil','combat_state.dead','Tot',
    'condition.bleeding','Blutend','condition.stunned','Betäubt','condition.prone','Liegend','condition.charmed','Bezaubert','condition.frightened','Verängstigt','condition.poisoned','Vergiftet','condition.exhausted','Erschöpft','condition.restrained','Festgesetzt','condition.off-balance','Aus dem Gleichgewicht',
    'item.oil_flask','Ölflasche','item.healing_potion','Heiltrank','item.torch','Fackel','item.shortsword','Kurzschwert','item.water_skin','Wasserschlauch','item.rope_50ft','Seil 15 m',
    'string_band.hostile','Feindselig','string_band.wary','Misstrauisch','string_band.neutral','Neutral','string_band.friendly','Freundlich','string_band.trusted','Vertraut','string_band.bonded','Gebunden',
    'surface.fire','Feuer','surface.oil','Öl','surface.water','Wasser','surface.ice','Eis','surface.electric','Elektrisch','surface.poison','Gift','surface.blood','Blut','surface.smoke','Rauch','surface.steam','Dampf','surface.acid','Säure','surface.web','Netz','surface.lava','Lava',
    'trauma.first_time','Erstes Mal','trauma.betrayed','Verraten','trauma.witnessed_death','Tod gesehen','trauma.violated','Verletzt','trauma.abandoned','Verlassen','trauma.humiliated','Gedemütigt'
  )),
  ('it', jsonb_build_object(
    'combat_state.active','Attivo','combat_state.downed','A terra','combat_state.stable','Stabile','combat_state.dead','Morto',
    'condition.bleeding','Sanguinante','condition.stunned','Stordito','condition.prone','Prono','condition.charmed','Ammaliato','condition.frightened','Spaventato','condition.poisoned','Avvelenato','condition.exhausted','Esausto','condition.restrained','Trattenuto','condition.off-balance','Sbilanciato',
    'item.oil_flask','Ampolla dolio','item.healing_potion','Pozione curativa','item.torch','Torcia','item.shortsword','Spada corta','item.water_skin','Otre dacqua','item.rope_50ft','Corda 15 m',
    'string_band.hostile','Ostile','string_band.wary','Diffidente','string_band.neutral','Neutrale','string_band.friendly','Amichevole','string_band.trusted','Fidato','string_band.bonded','Legato',
    'surface.fire','Fuoco','surface.oil','Olio','surface.water','Acqua','surface.ice','Ghiaccio','surface.electric','Elettricità','surface.poison','Veleno','surface.blood','Sangue','surface.smoke','Fumo','surface.steam','Vapore','surface.acid','Acido','surface.web','Ragnatela','surface.lava','Lava',
    'trauma.first_time','Prima volta','trauma.betrayed','Tradito','trauma.witnessed_death','Morte vista','trauma.violated','Violato','trauma.abandoned','Abbandonato','trauma.humiliated','Umiliato'
  )),
  ('pt', jsonb_build_object(
    'combat_state.active','Ativo','combat_state.downed','Caído','combat_state.stable','Estável','combat_state.dead','Morto',
    'condition.bleeding','Sangrando','condition.stunned','Atordoado','condition.prone','Caído','condition.charmed','Enfeitiçado','condition.frightened','Assustado','condition.poisoned','Envenenado','condition.exhausted','Exausto','condition.restrained','Contido','condition.off-balance','Desequilibrado',
    'item.oil_flask','Frasco de óleo','item.healing_potion','Poção de cura','item.torch','Tocha','item.shortsword','Espada curta','item.water_skin','Odre de água','item.rope_50ft','Corda 15 m',
    'string_band.hostile','Hostil','string_band.wary','Cauteloso','string_band.neutral','Neutro','string_band.friendly','Amigável','string_band.trusted','Confiável','string_band.bonded','Ligado',
    'surface.fire','Fogo','surface.oil','Óleo','surface.water','Água','surface.ice','Gelo','surface.electric','Eletricidade','surface.poison','Veneno','surface.blood','Sangue','surface.smoke','Fumaça','surface.steam','Vapor','surface.acid','Ácido','surface.web','Teia','surface.lava','Lava',
    'trauma.first_time','Primeira vez','trauma.betrayed','Traído','trauma.witnessed_death','Viu morte','trauma.violated','Violado','trauma.abandoned','Abandonado','trauma.humiliated','Humilhado'
  )),
  ('ro', jsonb_build_object(
    'combat_state.active','Activ','combat_state.downed','Doborât','combat_state.stable','Stabil','combat_state.dead','Mort',
    'condition.bleeding','Sângerare','condition.stunned','Amețit','condition.prone','La pământ','condition.charmed','Fermecat','condition.frightened','Înfricoșat','condition.poisoned','Otrăvit','condition.exhausted','Epuizat','condition.restrained','Imobilizat','condition.off-balance','Dezechilibrat',
    'item.oil_flask','Flacon cu ulei','item.healing_potion','Poțiune de vindecare','item.torch','Torță','item.shortsword','Sabie scurtă','item.water_skin','Burduf cu apă','item.rope_50ft','Frânghie 15 m',
    'string_band.hostile','Ostil','string_band.wary','Precaut','string_band.neutral','Neutru','string_band.friendly','Prietenos','string_band.trusted','De încredere','string_band.bonded','Legat',
    'surface.fire','Foc','surface.oil','Ulei','surface.water','Apă','surface.ice','Gheață','surface.electric','Electric','surface.poison','Otravă','surface.blood','Sânge','surface.smoke','Fum','surface.steam','Abur','surface.acid','Acid','surface.web','Pânză','surface.lava','Lavă',
    'trauma.first_time','Prima dată','trauma.betrayed','Trădat','trauma.witnessed_death','A văzut moarte','trauma.violated','Vătămat','trauma.abandoned','Abandonat','trauma.humiliated','Umilit'
  )),
  ('he', jsonb_build_object(
    'combat_state.active','פעיל','combat_state.downed','מובס','combat_state.stable','יציב','combat_state.dead','מת',
    'condition.bleeding','מדמם','condition.stunned','המום','condition.prone','שרוע','condition.charmed','מוקסם','condition.frightened','מפוחד','condition.poisoned','מורעל','condition.exhausted','מותש','condition.restrained','מרוסן','condition.off-balance','חסר שיווי משקל',
    'item.oil_flask','בקבוק שמן','item.healing_potion','שיקוי ריפוי','item.torch','לפיד','item.shortsword','חרב קצרה','item.water_skin','נאד מים','item.rope_50ft','חבל 15 מ',
    'string_band.hostile','עוין','string_band.wary','חשדן','string_band.neutral','ניטרלי','string_band.friendly','ידידותי','string_band.trusted','מהימן','string_band.bonded','קשור',
    'surface.fire','אש','surface.oil','שמן','surface.water','מים','surface.ice','קרח','surface.electric','חשמל','surface.poison','רעל','surface.blood','דם','surface.smoke','עשן','surface.steam','אדים','surface.acid','חומצה','surface.web','קורים','surface.lava','לבה',
    'trauma.first_time','פעם ראשונה','trauma.betrayed','נבגד','trauma.witnessed_death','ראה מוות','trauma.violated','נפגע','trauma.abandoned','ננטש','trauma.humiliated','הושפל'
  )),
  ('ar', jsonb_build_object(
    'combat_state.active','نشط','combat_state.downed','ساقط','combat_state.stable','مستقر','combat_state.dead','ميت',
    'condition.bleeding','نزيف','condition.stunned','مذهول','condition.prone','منبطح','condition.charmed','مسحور','condition.frightened','خائف','condition.poisoned','مسموم','condition.exhausted','مرهق','condition.restrained','مقيد','condition.off-balance','فاقد التوازن',
    'item.oil_flask','قارورة زيت','item.healing_potion','جرعة شفاء','item.torch','مشعل','item.shortsword','سيف قصير','item.water_skin','قربة ماء','item.rope_50ft','حبل 15 م',
    'string_band.hostile','عدائي','string_band.wary','حذر','string_band.neutral','محايد','string_band.friendly','ودود','string_band.trusted','موثوق','string_band.bonded','مرتبط',
    'surface.fire','نار','surface.oil','زيت','surface.water','ماء','surface.ice','جليد','surface.electric','كهرباء','surface.poison','سم','surface.blood','دم','surface.smoke','دخان','surface.steam','بخار','surface.acid','حمض','surface.web','شبكة','surface.lava','حمم',
    'trauma.first_time','المرة الأولى','trauma.betrayed','مخدوع','trauma.witnessed_death','شهد موتا','trauma.violated','منتهك','trauma.abandoned','متروك','trauma.humiliated','مذلول'
  )),
  ('fa', jsonb_build_object(
    'combat_state.active','فعال','combat_state.downed','افتاده','combat_state.stable','پایدار','combat_state.dead','مرده',
    'condition.bleeding','خونریزی','condition.stunned','گیج','condition.prone','بر زمین','condition.charmed','افسون‌شده','condition.frightened','ترسیده','condition.poisoned','مسموم','condition.exhausted','فرسوده','condition.restrained','مهار شده','condition.off-balance','نامتعادل',
    'item.oil_flask','فلاسک روغن','item.healing_potion','معجون درمان','item.torch','مشعل','item.shortsword','شمشیر کوتاه','item.water_skin','مشک آب','item.rope_50ft','طناب ۱۵ متر',
    'string_band.hostile','خصمانه','string_band.wary','محتاط','string_band.neutral','بی‌طرف','string_band.friendly','دوستانه','string_band.trusted','مورد اعتماد','string_band.bonded','پیوندخورده',
    'surface.fire','آتش','surface.oil','روغن','surface.water','آب','surface.ice','یخ','surface.electric','برق','surface.poison','زهر','surface.blood','خون','surface.smoke','دود','surface.steam','بخار','surface.acid','اسید','surface.web','تار','surface.lava','گدازه',
    'trauma.first_time','بار نخست','trauma.betrayed','خیانت‌دیده','trauma.witnessed_death','مرگ دیده','trauma.violated','آسیب‌دیده','trauma.abandoned','رها شده','trauma.humiliated','تحقیر شده'
  )),
  ('ur', jsonb_build_object(
    'combat_state.active','فعال','combat_state.downed','گرا ہوا','combat_state.stable','مستحکم','combat_state.dead','مردہ',
    'condition.bleeding','خون بہنا','condition.stunned','حیران','condition.prone','زمین پر','condition.charmed','مسحور','condition.frightened','خائف','condition.poisoned','زہریلا','condition.exhausted','تھکا ہوا','condition.restrained','جکڑا ہوا','condition.off-balance','بے توازن',
    'item.oil_flask','تیل کی شیشی','item.healing_potion','شفا کی دوا','item.torch','مشعل','item.shortsword','چھوٹی تلوار','item.water_skin','پانی کی مشک','item.rope_50ft','رسی 15 م',
    'string_band.hostile','دشمن','string_band.wary','محتاط','string_band.neutral','غیر جانبدار','string_band.friendly','دوستانہ','string_band.trusted','قابل اعتماد','string_band.bonded','بندھا ہوا',
    'surface.fire','آگ','surface.oil','تیل','surface.water','پانی','surface.ice','برف','surface.electric','بجلی','surface.poison','زہر','surface.blood','خون','surface.smoke','دھواں','surface.steam','بھاپ','surface.acid','تیزاب','surface.web','جالا','surface.lava','لاوا',
    'trauma.first_time','پہلی بار','trauma.betrayed','دھوکا کھایا','trauma.witnessed_death','موت دیکھی','trauma.violated','مجروح','trauma.abandoned','چھوڑا گیا','trauma.humiliated','ذلیل'
  )),
  ('hi', jsonb_build_object(
    'combat_state.active','सक्रिय','combat_state.downed','गिरा हुआ','combat_state.stable','स्थिर','combat_state.dead','मृत',
    'condition.bleeding','रक्तस्राव','condition.stunned','स्तब्ध','condition.prone','भूमि पर','condition.charmed','मोहित','condition.frightened','भयभीत','condition.poisoned','विषाक्त','condition.exhausted','थका हुआ','condition.restrained','बंधा हुआ','condition.off-balance','असंतुलित',
    'item.oil_flask','तेल की शीशी','item.healing_potion','उपचार औषधि','item.torch','मशाल','item.shortsword','छोटी तलवार','item.water_skin','जल मशक','item.rope_50ft','रस्सी 15 मी',
    'string_band.hostile','शत्रुतापूर्ण','string_band.wary','सावधान','string_band.neutral','तटस्थ','string_band.friendly','मैत्रीपूर्ण','string_band.trusted','विश्वस्त','string_band.bonded','बंधित',
    'surface.fire','आग','surface.oil','तेल','surface.water','जल','surface.ice','बर्फ','surface.electric','विद्युत','surface.poison','विष','surface.blood','रक्त','surface.smoke','धुआं','surface.steam','भाप','surface.acid','अम्ल','surface.web','जाला','surface.lava','लावा',
    'trauma.first_time','पहली बार','trauma.betrayed','धोखा खाया','trauma.witnessed_death','मृत्यु देखी','trauma.violated','आहत','trauma.abandoned','छोड़ा गया','trauma.humiliated','अपमानित'
  )),
  ('mr', jsonb_build_object(
    'combat_state.active','सक्रिय','combat_state.downed','पडलेला','combat_state.stable','स्थिर','combat_state.dead','मृत',
    'condition.bleeding','रक्तस्त्राव','condition.stunned','बधिर','condition.prone','जमिनीवर','condition.charmed','मोहित','condition.frightened','घाबरलेला','condition.poisoned','विषबाधित','condition.exhausted','थकलेला','condition.restrained','बांधलेला','condition.off-balance','असंतुलित',
    'item.oil_flask','तेलाची कुपी','item.healing_potion','उपचार औषध','item.torch','मशाल','item.shortsword','लहान तलवार','item.water_skin','पाण्याची पिशवी','item.rope_50ft','दोरा 15 मी',
    'string_band.hostile','वैरभावी','string_band.wary','सावध','string_band.neutral','तटस्थ','string_band.friendly','मैत्रीपूर्ण','string_band.trusted','विश्वस्त','string_band.bonded','बंधलेला',
    'surface.fire','आग','surface.oil','तेल','surface.water','पाणी','surface.ice','बर्फ','surface.electric','विद्युत','surface.poison','विष','surface.blood','रक्त','surface.smoke','धूर','surface.steam','वाफ','surface.acid','आम्ल','surface.web','जाळे','surface.lava','लावा',
    'trauma.first_time','पहिल्यांदा','trauma.betrayed','फसवलेला','trauma.witnessed_death','मृत्यू पाहिला','trauma.violated','जखमी','trauma.abandoned','सोडलेला','trauma.humiliated','अपमानित'
  )),
  ('ne', jsonb_build_object(
    'combat_state.active','सक्रिय','combat_state.downed','ढलेको','combat_state.stable','स्थिर','combat_state.dead','मृत',
    'condition.bleeding','रगत बगिरहेको','condition.stunned','अचेत','condition.prone','भुइँमा','condition.charmed','मोहित','condition.frightened','डराएको','condition.poisoned','विष लागेको','condition.exhausted','थाकेको','condition.restrained','बाँधिएको','condition.off-balance','असन्तुलित',
    'item.oil_flask','तेलको बोतल','item.healing_potion','उपचार औषधि','item.torch','मशाल','item.shortsword','छोटो तरवार','item.water_skin','पानीको मशक','item.rope_50ft','डोरी 15 मि',
    'string_band.hostile','शत्रुतापूर्ण','string_band.wary','सावधान','string_band.neutral','तटस्थ','string_band.friendly','मैत्रीपूर्ण','string_band.trusted','विश्वस्त','string_band.bonded','बाँधिएको',
    'surface.fire','आगो','surface.oil','तेल','surface.water','पानी','surface.ice','बरफ','surface.electric','बिजुली','surface.poison','विष','surface.blood','रगत','surface.smoke','धुवाँ','surface.steam','बाफ','surface.acid','अम्ल','surface.web','जालो','surface.lava','लाभा',
    'trauma.first_time','पहिलो पटक','trauma.betrayed','धोका खाएको','trauma.witnessed_death','मृत्यु देखेको','trauma.violated','आहत','trauma.abandoned','छोडिएको','trauma.humiliated','अपमानित'
  )),
  ('bn', jsonb_build_object(
    'combat_state.active','সক্রিয়','combat_state.downed','পড়ে গেছে','combat_state.stable','স্থিতিশীল','combat_state.dead','মৃত',
    'condition.bleeding','রক্তপাত','condition.stunned','স্তব্ধ','condition.prone','মাটিতে','condition.charmed','মোহিত','condition.frightened','ভীত','condition.poisoned','বিষাক্ত','condition.exhausted','ক্লান্ত','condition.restrained','আটকানো','condition.off-balance','ভারসাম্যহীন',
    'item.oil_flask','তেলের শিশি','item.healing_potion','চিকিৎসা ওষুধ','item.torch','মশাল','item.shortsword','ছোট তলোয়ার','item.water_skin','জলের মশক','item.rope_50ft','দড়ি ১৫ মি',
    'string_band.hostile','শত্রুভাবাপন্ন','string_band.wary','সতর্ক','string_band.neutral','নিরপেক্ষ','string_band.friendly','বন্ধুসুলভ','string_band.trusted','বিশ্বস্ত','string_band.bonded','বন্ধিত',
    'surface.fire','আগুন','surface.oil','তেল','surface.water','জল','surface.ice','বরফ','surface.electric','বিদ্যুৎ','surface.poison','বিষ','surface.blood','রক্ত','surface.smoke','ধোঁয়া','surface.steam','বাষ্প','surface.acid','অম্ল','surface.web','জাল','surface.lava','লাভা',
    'trauma.first_time','প্রথমবার','trauma.betrayed','প্রতারিত','trauma.witnessed_death','মৃত্যু দেখেছে','trauma.violated','আহত','trauma.abandoned','পরিত্যক্ত','trauma.humiliated','অপমানিত'
  )),
  ('th', jsonb_build_object(
    'combat_state.active','พร้อมสู้','combat_state.downed','ล้มลง','combat_state.stable','คงที่','combat_state.dead','ตาย',
    'condition.bleeding','เลือดออก','condition.stunned','มึนงง','condition.prone','ล้มคว่ำ','condition.charmed','ถูกเสน่ห์','condition.frightened','หวาดกลัว','condition.poisoned','ติดพิษ','condition.exhausted','หมดแรง','condition.restrained','ถูกตรึง','condition.off-balance','เสียหลัก',
    'item.oil_flask','ขวดน้ำมัน','item.healing_potion','ยารักษา','item.torch','คบไฟ','item.shortsword','ดาบสั้น','item.water_skin','ถุงน้ำ','item.rope_50ft','เชือก 15 ม',
    'string_band.hostile','เป็นศัตรู','string_band.wary','ระแวง','string_band.neutral','เป็นกลาง','string_band.friendly','เป็นมิตร','string_band.trusted','ไว้ใจ','string_band.bonded','ผูกพัน',
    'surface.fire','ไฟ','surface.oil','น้ำมัน','surface.water','น้ำ','surface.ice','น้ำแข็ง','surface.electric','ไฟฟ้า','surface.poison','พิษ','surface.blood','เลือด','surface.smoke','ควัน','surface.steam','ไอน้ำ','surface.acid','กรด','surface.web','ใย','surface.lava','ลาวา',
    'trauma.first_time','ครั้งแรก','trauma.betrayed','ถูกหักหลัง','trauma.witnessed_death','เห็นความตาย','trauma.violated','ถูกทำร้าย','trauma.abandoned','ถูกทอดทิ้ง','trauma.humiliated','ถูกทำให้อับอาย'
  )),
  ('el', jsonb_build_object(
    'combat_state.active','Ενεργός','combat_state.downed','Πεσμένος','combat_state.stable','Σταθερός','combat_state.dead','Νεκρός',
    'condition.bleeding','Αιμορραγεί','condition.stunned','Ζαλισμένος','condition.prone','Πεσμένος','condition.charmed','Γοητευμένος','condition.frightened','Φοβισμένος','condition.poisoned','Δηλητηριασμένος','condition.exhausted','Εξαντλημένος','condition.restrained','Περιορισμένος','condition.off-balance','Εκτός ισορροπίας',
    'item.oil_flask','Φιαλίδιο λαδιού','item.healing_potion','Φίλτρο θεραπείας','item.torch','Δάδα','item.shortsword','Κοντό σπαθί','item.water_skin','Ασκός νερού','item.rope_50ft','Σχοινί 15 μ',
    'string_band.hostile','Εχθρικός','string_band.wary','Επιφυλακτικός','string_band.neutral','Ουδέτερος','string_band.friendly','Φιλικός','string_band.trusted','Έμπιστος','string_band.bonded','Δεμένος',
    'surface.fire','Φωτιά','surface.oil','Λάδι','surface.water','Νερό','surface.ice','Πάγος','surface.electric','Ηλεκτρισμός','surface.poison','Δηλητήριο','surface.blood','Αίμα','surface.smoke','Καπνός','surface.steam','Ατμός','surface.acid','Οξύ','surface.web','Ιστός','surface.lava','Λάβα',
    'trauma.first_time','Πρώτη φορά','trauma.betrayed','Προδομένος','trauma.witnessed_death','Είδε θάνατο','trauma.violated','Βλαμμένος','trauma.abandoned','Εγκαταλειμμένος','trauma.humiliated','Ταπεινωμένος'
  )),
  ('hy', jsonb_build_object(
    'combat_state.active','Ակտիվ','combat_state.downed','Ընկած','combat_state.stable','Կայուն','combat_state.dead','Մեռած',
    'condition.bleeding','Արյունահոսություն','condition.stunned','Շշմած','condition.prone','Գետնին','condition.charmed','Կախարդված','condition.frightened','Վախեցած','condition.poisoned','Թունավորված','condition.exhausted','Հյուծված','condition.restrained','Սահմանափակված','condition.off-balance','Անհավասարակշիռ',
    'item.oil_flask','Յուղի սրվակ','item.healing_potion','Բուժման թուրմ','item.torch','Ջահ','item.shortsword','Կարճ սուր','item.water_skin','Ջրի տիկ','item.rope_50ft','Պարան 15 մ',
    'string_band.hostile','Թշնամական','string_band.wary','Զգուշավոր','string_band.neutral','Չեզոք','string_band.friendly','Բարեկամական','string_band.trusted','Վստահելի','string_band.bonded','Կապված',
    'surface.fire','Կրակ','surface.oil','Յուղ','surface.water','Ջուր','surface.ice','Սառույց','surface.electric','Էլեկտրական','surface.poison','Թույն','surface.blood','Արյուն','surface.smoke','Ծուխ','surface.steam','Գոլորշի','surface.acid','Թթու','surface.web','Սարդոստայն','surface.lava','Լավա',
    'trauma.first_time','Առաջին անգամ','trauma.betrayed','Դավաճանված','trauma.witnessed_death','Տեսել է մահ','trauma.violated','Վնասված','trauma.abandoned','Լքված','trauma.humiliated','Նսեմացված'
  )),
  ('ka', jsonb_build_object(
    'combat_state.active','აქტიური','combat_state.downed','დაცემული','combat_state.stable','სტაბილური','combat_state.dead','მკვდარი',
    'condition.bleeding','სისხლდენა','condition.stunned','გაბრუებული','condition.prone','მიწაზე','condition.charmed','მოხიბლული','condition.frightened','შეშინებული','condition.poisoned','მოწამლული','condition.exhausted','გამოფიტული','condition.restrained','შეზღუდული','condition.off-balance','წონასწორობადაკარგული',
    'item.oil_flask','ზეთის ფლაკონი','item.healing_potion','სამკურნალო ელექსირი','item.torch','ჩირაღდანი','item.shortsword','მოკლე ხმალი','item.water_skin','წყლის ტიკი','item.rope_50ft','თოკი 15 მ',
    'string_band.hostile','მტრული','string_band.wary','ფრთხილი','string_band.neutral','ნეიტრალური','string_band.friendly','მეგობრული','string_band.trusted','სანდო','string_band.bonded','დაკავშირებული',
    'surface.fire','ცეცხლი','surface.oil','ზეთი','surface.water','წყალი','surface.ice','ყინული','surface.electric','ელექტრობა','surface.poison','შხამი','surface.blood','სისხლი','surface.smoke','კვამლი','surface.steam','ორთქლი','surface.acid','მჟავა','surface.web','აბლაბუდა','surface.lava','ლავა',
    'trauma.first_time','პირველად','trauma.betrayed','ღალატით ნატკენი','trauma.witnessed_death','სიკვდილი ნახა','trauma.violated','დაზიანებული','trauma.abandoned','მიტოვებული','trauma.humiliated','დამცირებული'
  )),
  ('ko', jsonb_build_object(
    'combat_state.active','활성','combat_state.downed','쓰러짐','combat_state.stable','안정','combat_state.dead','사망',
    'condition.bleeding','출혈','condition.stunned','기절','condition.prone','엎드림','condition.charmed','매혹됨','condition.frightened','공포','condition.poisoned','중독','condition.exhausted','탈진','condition.restrained','구속됨','condition.off-balance','균형 상실',
    'item.oil_flask','기름 병','item.healing_potion','치유 물약','item.torch','횃불','item.shortsword','단검','item.water_skin','물주머니','item.rope_50ft','밧줄 15 m',
    'string_band.hostile','적대','string_band.wary','경계','string_band.neutral','중립','string_band.friendly','우호','string_band.trusted','신뢰','string_band.bonded','유대',
    'surface.fire','불','surface.oil','기름','surface.water','물','surface.ice','얼음','surface.electric','전기','surface.poison','독','surface.blood','피','surface.smoke','연기','surface.steam','증기','surface.acid','산','surface.web','거미줄','surface.lava','용암',
    'trauma.first_time','첫 경험','trauma.betrayed','배신당함','trauma.witnessed_death','죽음을 목격','trauma.violated','침해됨','trauma.abandoned','버려짐','trauma.humiliated','굴욕'
  )),
  ('ja', jsonb_build_object(
    'combat_state.active','行動可能','combat_state.downed','倒れた','combat_state.stable','安定','combat_state.dead','死亡',
    'condition.bleeding','出血','condition.stunned','朦朧','condition.prone','伏せ','condition.charmed','魅了','condition.frightened','恐怖','condition.poisoned','毒','condition.exhausted','消耗','condition.restrained','拘束','condition.off-balance','体勢崩れ',
    'item.oil_flask','油の小瓶','item.healing_potion','治癒のポーション','item.torch','松明','item.shortsword','ショートソード','item.water_skin','水袋','item.rope_50ft','ロープ15m',
    'string_band.hostile','敵対','string_band.wary','警戒','string_band.neutral','中立','string_band.friendly','友好','string_band.trusted','信頼','string_band.bonded','絆',
    'surface.fire','火','surface.oil','油','surface.water','水','surface.ice','氷','surface.electric','電気','surface.poison','毒','surface.blood','血','surface.smoke','煙','surface.steam','蒸気','surface.acid','酸','surface.web','網','surface.lava','溶岩',
    'trauma.first_time','初めて','trauma.betrayed','裏切られた','trauma.witnessed_death','死を見た','trauma.violated','傷つけられた','trauma.abandoned','見捨てられた','trauma.humiliated','屈辱'
  )),
  ('zh', jsonb_build_object(
    'combat_state.active','可行动','combat_state.downed','倒地','combat_state.stable','稳定','combat_state.dead','死亡',
    'condition.bleeding','流血','condition.stunned','震慑','condition.prone','倒伏','condition.charmed','魅惑','condition.frightened','惊恐','condition.poisoned','中毒','condition.exhausted','力竭','condition.restrained','受缚','condition.off-balance','失衡',
    'item.oil_flask','油瓶','item.healing_potion','治疗药水','item.torch','火把','item.shortsword','短剑','item.water_skin','水袋','item.rope_50ft','绳索15米',
    'string_band.hostile','敌对','string_band.wary','戒备','string_band.neutral','中立','string_band.friendly','友好','string_band.trusted','信任','string_band.bonded','羁绊',
    'surface.fire','火','surface.oil','油','surface.water','水','surface.ice','冰','surface.electric','电','surface.poison','毒','surface.blood','血','surface.smoke','烟','surface.steam','蒸汽','surface.acid','酸','surface.web','蛛网','surface.lava','熔岩',
    'trauma.first_time','第一次','trauma.betrayed','被背叛','trauma.witnessed_death','见证死亡','trauma.violated','受侵害','trauma.abandoned','被遗弃','trauma.humiliated','受辱'
  ))
)
INSERT INTO i18n_translations (key, lang, value)
SELECT entry.key, packs.lang, entry.value
FROM packs
CROSS JOIN LATERAL jsonb_each_text(packs.entries) AS entry(key, value)
ON CONFLICT (key, lang) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = now();
