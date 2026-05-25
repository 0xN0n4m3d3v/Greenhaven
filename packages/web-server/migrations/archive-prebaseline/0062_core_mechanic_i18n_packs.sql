-- Spec 110 - complete core mechanic labels for every supported UI language.
-- This migration covers the stable non-lore vocabulary used by character
-- sheets, dice checks, mode badges, and scene time labels.

WITH packs(lang, entries) AS (
  VALUES
  ('uk', jsonb_build_object(
    'mode.combat','Бій','mode.dialogue','Діалог','mode.exploration','Дослідження','mode.travel','Подорож','mode.rest','Відпочинок','mode.intimacy','Близькість',
    'stat.STR','СИЛ','stat.DEX','СПР','stat.CON','СТА','stat.INT','ІНТ','stat.WIS','МУД','stat.CHA','ХАР',
    'skill.acrobatics','Акробатика','skill.animal_handling','Тварини','skill.arcana','Аркана','skill.athletics','Атлетика','skill.deception','Обман','skill.history','Історія','skill.insight','Проникливість','skill.intimidation','Залякування','skill.investigation','Розслідування','skill.medicine','Медицина','skill.nature','Природа','skill.perception','Уважність','skill.performance','Виступ','skill.persuasion','Переконання','skill.religion','Релігія','skill.sleight_of_hand','Спритність рук','skill.stealth','Скритність','skill.survival','Виживання',
    'scene.day_label','День {day}','time.dawn','Світанок','time.morning','Ранок','time.noon','Полудень','time.afternoon','Після полудня','time.dusk','Сутінки','time.night','Ніч','time.midnight','Північ'
  )),
  ('bg', jsonb_build_object(
    'mode.combat','Бой','mode.dialogue','Диалог','mode.exploration','Изследване','mode.travel','Пътуване','mode.rest','Почивка','mode.intimacy','Близост',
    'stat.STR','СИЛ','stat.DEX','ЛОВ','stat.CON','ИЗД','stat.INT','ИНТ','stat.WIS','МЪД','stat.CHA','ХАР',
    'skill.acrobatics','Акробатика','skill.animal_handling','Животни','skill.arcana','Аркана','skill.athletics','Атлетика','skill.deception','Измама','skill.history','История','skill.insight','Проницателност','skill.intimidation','Сплашване','skill.investigation','Разследване','skill.medicine','Медицина','skill.nature','Природа','skill.perception','Възприятие','skill.performance','Изпълнение','skill.persuasion','Убеждаване','skill.religion','Религия','skill.sleight_of_hand','Ловкост на ръцете','skill.stealth','Промъкване','skill.survival','Оцеляване',
    'scene.day_label','Ден {day}','time.dawn','Зора','time.morning','Сутрин','time.noon','Пладне','time.afternoon','Следобед','time.dusk','Здрач','time.night','Нощ','time.midnight','Полунощ'
  )),
  ('sr', jsonb_build_object(
    'mode.combat','Борба','mode.dialogue','Дијалог','mode.exploration','Истраживање','mode.travel','Путовање','mode.rest','Одмор','mode.intimacy','Блискост',
    'stat.STR','СНА','stat.DEX','СПР','stat.CON','ИЗД','stat.INT','ИНТ','stat.WIS','МУД','stat.CHA','ХАР',
    'skill.acrobatics','Акробатика','skill.animal_handling','Рад са животињама','skill.arcana','Аркана','skill.athletics','Атлетика','skill.deception','Обмана','skill.history','Историја','skill.insight','Проницљивост','skill.intimidation','Застрашивање','skill.investigation','Истрага','skill.medicine','Медицина','skill.nature','Природа','skill.perception','Опажање','skill.performance','Наступ','skill.persuasion','Убеђивање','skill.religion','Религија','skill.sleight_of_hand','Спретност руку','skill.stealth','Прикривање','skill.survival','Преживљавање',
    'scene.day_label','Дан {day}','time.dawn','Зора','time.morning','Јутро','time.noon','Подне','time.afternoon','Поподне','time.dusk','Сумрак','time.night','Ноћ','time.midnight','Поноћ'
  )),
  ('es', jsonb_build_object(
    'mode.combat','Combate','mode.dialogue','Diálogo','mode.exploration','Exploración','mode.travel','Viaje','mode.rest','Descanso','mode.intimacy','Intimidad',
    'stat.STR','FUE','stat.DEX','DES','stat.CON','CON','stat.INT','INT','stat.WIS','SAB','stat.CHA','CAR',
    'skill.acrobatics','Acrobacias','skill.animal_handling','Trato con animales','skill.arcana','Arcanos','skill.athletics','Atletismo','skill.deception','Engaño','skill.history','Historia','skill.insight','Perspicacia','skill.intimidation','Intimidación','skill.investigation','Investigación','skill.medicine','Medicina','skill.nature','Naturaleza','skill.perception','Percepción','skill.performance','Interpretación','skill.persuasion','Persuasión','skill.religion','Religión','skill.sleight_of_hand','Juego de manos','skill.stealth','Sigilo','skill.survival','Supervivencia',
    'scene.day_label','Día {day}','time.dawn','Amanecer','time.morning','Mañana','time.noon','Mediodía','time.afternoon','Tarde','time.dusk','Crepúsculo','time.night','Noche','time.midnight','Medianoche'
  )),
  ('fr', jsonb_build_object(
    'mode.combat','Combat','mode.dialogue','Dialogue','mode.exploration','Exploration','mode.travel','Voyage','mode.rest','Repos','mode.intimacy','Intimité',
    'stat.STR','FOR','stat.DEX','DEX','stat.CON','CON','stat.INT','INT','stat.WIS','SAG','stat.CHA','CHA',
    'skill.acrobatics','Acrobaties','skill.animal_handling','Dressage','skill.arcana','Arcanes','skill.athletics','Athlétisme','skill.deception','Tromperie','skill.history','Histoire','skill.insight','Intuition','skill.intimidation','Intimidation','skill.investigation','Investigation','skill.medicine','Médecine','skill.nature','Nature','skill.perception','Perception','skill.performance','Représentation','skill.persuasion','Persuasion','skill.religion','Religion','skill.sleight_of_hand','Escamotage','skill.stealth','Discrétion','skill.survival','Survie',
    'scene.day_label','Jour {day}','time.dawn','Aube','time.morning','Matin','time.noon','Midi','time.afternoon','Après-midi','time.dusk','Crépuscule','time.night','Nuit','time.midnight','Minuit'
  )),
  ('de', jsonb_build_object(
    'mode.combat','Kampf','mode.dialogue','Dialog','mode.exploration','Erkundung','mode.travel','Reise','mode.rest','Rast','mode.intimacy','Nähe',
    'stat.STR','STR','stat.DEX','GES','stat.CON','KON','stat.INT','INT','stat.WIS','WEI','stat.CHA','CHA',
    'skill.acrobatics','Akrobatik','skill.animal_handling','Umgang mit Tieren','skill.arcana','Arkane Kunde','skill.athletics','Athletik','skill.deception','Täuschung','skill.history','Geschichte','skill.insight','Motiv erkennen','skill.intimidation','Einschüchtern','skill.investigation','Nachforschung','skill.medicine','Heilkunde','skill.nature','Naturkunde','skill.perception','Wahrnehmung','skill.performance','Auftreten','skill.persuasion','Überreden','skill.religion','Religion','skill.sleight_of_hand','Fingerfertigkeit','skill.stealth','Heimlichkeit','skill.survival','Überleben',
    'scene.day_label','Tag {day}','time.dawn','Morgengrauen','time.morning','Morgen','time.noon','Mittag','time.afternoon','Nachmittag','time.dusk','Dämmerung','time.night','Nacht','time.midnight','Mitternacht'
  )),
  ('it', jsonb_build_object(
    'mode.combat','Combattimento','mode.dialogue','Dialogo','mode.exploration','Esplorazione','mode.travel','Viaggio','mode.rest','Riposo','mode.intimacy','Intimità',
    'stat.STR','FOR','stat.DEX','DES','stat.CON','COS','stat.INT','INT','stat.WIS','SAG','stat.CHA','CAR',
    'skill.acrobatics','Acrobazia','skill.animal_handling','Addestrare animali','skill.arcana','Arcano','skill.athletics','Atletica','skill.deception','Inganno','skill.history','Storia','skill.insight','Intuizione','skill.intimidation','Intimidire','skill.investigation','Indagare','skill.medicine','Medicina','skill.nature','Natura','skill.perception','Percezione','skill.performance','Intrattenere','skill.persuasion','Persuasione','skill.religion','Religione','skill.sleight_of_hand','Rapidità di mano','skill.stealth','Furtività','skill.survival','Sopravvivenza',
    'scene.day_label','Giorno {day}','time.dawn','Alba','time.morning','Mattina','time.noon','Mezzogiorno','time.afternoon','Pomeriggio','time.dusk','Crepuscolo','time.night','Notte','time.midnight','Mezzanotte'
  )),
  ('pt', jsonb_build_object(
    'mode.combat','Combate','mode.dialogue','Diálogo','mode.exploration','Exploração','mode.travel','Viagem','mode.rest','Descanso','mode.intimacy','Intimidade',
    'stat.STR','FOR','stat.DEX','DES','stat.CON','CON','stat.INT','INT','stat.WIS','SAB','stat.CHA','CAR',
    'skill.acrobatics','Acrobacia','skill.animal_handling','Lidar com animais','skill.arcana','Arcanismo','skill.athletics','Atletismo','skill.deception','Enganação','skill.history','História','skill.insight','Intuição','skill.intimidation','Intimidação','skill.investigation','Investigação','skill.medicine','Medicina','skill.nature','Natureza','skill.perception','Percepção','skill.performance','Atuação','skill.persuasion','Persuasão','skill.religion','Religião','skill.sleight_of_hand','Prestidigitação','skill.stealth','Furtividade','skill.survival','Sobrevivência',
    'scene.day_label','Dia {day}','time.dawn','Aurora','time.morning','Manhã','time.noon','Meio-dia','time.afternoon','Tarde','time.dusk','Crepúsculo','time.night','Noite','time.midnight','Meia-noite'
  )),
  ('ro', jsonb_build_object(
    'mode.combat','Luptă','mode.dialogue','Dialog','mode.exploration','Explorare','mode.travel','Călătorie','mode.rest','Odihnă','mode.intimacy','Intimitate',
    'stat.STR','FOR','stat.DEX','DEX','stat.CON','CON','stat.INT','INT','stat.WIS','ÎNȚ','stat.CHA','CAR',
    'skill.acrobatics','Acrobație','skill.animal_handling','Îngrijirea animalelor','skill.arcana','Arcane','skill.athletics','Atletism','skill.deception','Înșelăciune','skill.history','Istorie','skill.insight','Intuiție','skill.intimidation','Intimidare','skill.investigation','Investigație','skill.medicine','Medicină','skill.nature','Natură','skill.perception','Percepție','skill.performance','Interpretare','skill.persuasion','Persuasiune','skill.religion','Religie','skill.sleight_of_hand','Îndemânare','skill.stealth','Furișare','skill.survival','Supraviețuire',
    'scene.day_label','Ziua {day}','time.dawn','Zori','time.morning','Dimineață','time.noon','Amiază','time.afternoon','După-amiază','time.dusk','Amurg','time.night','Noapte','time.midnight','Miezul nopții'
  )),
  ('he', jsonb_build_object(
    'mode.combat','קרב','mode.dialogue','דיאלוג','mode.exploration','חקירה','mode.travel','מסע','mode.rest','מנוחה','mode.intimacy','קרבה',
    'stat.STR','כוח','stat.DEX','זרז','stat.CON','חוסן','stat.INT','תבונה','stat.WIS','חכמה','stat.CHA','כרזמה',
    'skill.acrobatics','אקרובטיקה','skill.animal_handling','טיפול בחיות','skill.arcana','מאגיה','skill.athletics','אתלטיקה','skill.deception','הטעיה','skill.history','היסטוריה','skill.insight','תובנה','skill.intimidation','איום','skill.investigation','חקירה','skill.medicine','רפואה','skill.nature','טבע','skill.perception','תפיסה','skill.performance','הופעה','skill.persuasion','שכנוע','skill.religion','דת','skill.sleight_of_hand','זריזות ידיים','skill.stealth','התגנבות','skill.survival','הישרדות',
    'scene.day_label','יום {day}','time.dawn','שחר','time.morning','בוקר','time.noon','צהריים','time.afternoon','אחר הצהריים','time.dusk','דמדומים','time.night','לילה','time.midnight','חצות'
  )),
  ('ar', jsonb_build_object(
    'mode.combat','قتال','mode.dialogue','حوار','mode.exploration','استكشاف','mode.travel','سفر','mode.rest','راحة','mode.intimacy','ألفة',
    'stat.STR','قوة','stat.DEX','براعة','stat.CON','تحمل','stat.INT','ذكاء','stat.WIS','حكمة','stat.CHA','كاريزما',
    'skill.acrobatics','بهلوانيات','skill.animal_handling','التعامل مع الحيوانات','skill.arcana','أسرار','skill.athletics','ألعاب قوى','skill.deception','خداع','skill.history','تاريخ','skill.insight','بصيرة','skill.intimidation','ترهيب','skill.investigation','تحقيق','skill.medicine','طب','skill.nature','طبيعة','skill.perception','إدراك','skill.performance','أداء','skill.persuasion','إقناع','skill.religion','دين','skill.sleight_of_hand','خفة يد','skill.stealth','تسلل','skill.survival','نجاة',
    'scene.day_label','اليوم {day}','time.dawn','فجر','time.morning','صباح','time.noon','ظهر','time.afternoon','بعد الظهر','time.dusk','غسق','time.night','ليل','time.midnight','منتصف الليل'
  )),
  ('fa', jsonb_build_object(
    'mode.combat','نبرد','mode.dialogue','گفتگو','mode.exploration','کاوش','mode.travel','سفر','mode.rest','استراحت','mode.intimacy','صمیمیت',
    'stat.STR','قدرت','stat.DEX','چابکی','stat.CON','بنیه','stat.INT','هوش','stat.WIS','خرد','stat.CHA','کاریزما',
    'skill.acrobatics','آکروباتیک','skill.animal_handling','کار با جانوران','skill.arcana','رازهای جادویی','skill.athletics','ورزشکاری','skill.deception','فریب','skill.history','تاریخ','skill.insight','بینش','skill.intimidation','ارعاب','skill.investigation','تحقیق','skill.medicine','پزشکی','skill.nature','طبیعت','skill.perception','ادراک','skill.performance','اجرا','skill.persuasion','اقناع','skill.religion','دین','skill.sleight_of_hand','تردستی','skill.stealth','پنهان‌کاری','skill.survival','بقا',
    'scene.day_label','روز {day}','time.dawn','سپیده','time.morning','صبح','time.noon','ظهر','time.afternoon','بعدازظهر','time.dusk','غروب','time.night','شب','time.midnight','نیمه‌شب'
  )),
  ('ur', jsonb_build_object(
    'mode.combat','لڑائی','mode.dialogue','مکالمہ','mode.exploration','کھوج','mode.travel','سفر','mode.rest','آرام','mode.intimacy','قربت',
    'stat.STR','طاقت','stat.DEX','پھرتی','stat.CON','برداشت','stat.INT','ذہانت','stat.WIS','حکمت','stat.CHA','کرشمہ',
    'skill.acrobatics','کرتب','skill.animal_handling','جانور سنبھالنا','skill.arcana','اسرار','skill.athletics','اتھلیٹکس','skill.deception','فریب','skill.history','تاریخ','skill.insight','بصیرت','skill.intimidation','دھمکانا','skill.investigation','تحقیق','skill.medicine','طب','skill.nature','فطرت','skill.perception','ادراک','skill.performance','کارکردگی','skill.persuasion','قائل کرنا','skill.religion','مذہب','skill.sleight_of_hand','ہاتھ کی صفائی','skill.stealth','چپکے چلنا','skill.survival','بقا',
    'scene.day_label','دن {day}','time.dawn','فجر','time.morning','صبح','time.noon','دوپہر','time.afternoon','سہ پہر','time.dusk','شام','time.night','رات','time.midnight','آدھی رات'
  )),
  ('hi', jsonb_build_object(
    'mode.combat','युद्ध','mode.dialogue','संवाद','mode.exploration','अन्वेषण','mode.travel','यात्रा','mode.rest','विश्राम','mode.intimacy','निकटता',
    'stat.STR','बल','stat.DEX','फुर्ती','stat.CON','सहन','stat.INT','बुद्धि','stat.WIS','विवेक','stat.CHA','करिश्मा',
    'skill.acrobatics','कलाबाज़ी','skill.animal_handling','पशु संभालना','skill.arcana','रहस्य विद्या','skill.athletics','एथलेटिक्स','skill.deception','छल','skill.history','इतिहास','skill.insight','अंतर्दृष्टि','skill.intimidation','धमकाना','skill.investigation','जांच','skill.medicine','चिकित्सा','skill.nature','प्रकृति','skill.perception','धारणा','skill.performance','प्रदर्शन','skill.persuasion','मनाना','skill.religion','धर्म','skill.sleight_of_hand','हाथ की सफाई','skill.stealth','गुप्तता','skill.survival','जीवित रहना',
    'scene.day_label','दिन {day}','time.dawn','भोर','time.morning','सुबह','time.noon','दोपहर','time.afternoon','अपराह्न','time.dusk','सांझ','time.night','रात','time.midnight','आधी रात'
  )),
  ('mr', jsonb_build_object(
    'mode.combat','लढाई','mode.dialogue','संवाद','mode.exploration','शोध','mode.travel','प्रवास','mode.rest','विश्रांती','mode.intimacy','जवळीक',
    'stat.STR','बल','stat.DEX','चपळ','stat.CON','सहन','stat.INT','बुद्धी','stat.WIS','प्रज्ञा','stat.CHA','करिश्मा',
    'skill.acrobatics','कसरत','skill.animal_handling','प्राणी हाताळणे','skill.arcana','गूढविद्या','skill.athletics','अॅथलेटिक्स','skill.deception','फसवणूक','skill.history','इतिहास','skill.insight','अंतर्दृष्टी','skill.intimidation','धमकावणे','skill.investigation','तपास','skill.medicine','वैद्यक','skill.nature','निसर्ग','skill.perception','आकलन','skill.performance','सादरीकरण','skill.persuasion','पटवणे','skill.religion','धर्म','skill.sleight_of_hand','हातचलाखी','skill.stealth','लपूनछपून','skill.survival','जगणे',
    'scene.day_label','दिवस {day}','time.dawn','पहाट','time.morning','सकाळ','time.noon','दुपार','time.afternoon','दुपारनंतर','time.dusk','संध्याकाळ','time.night','रात्र','time.midnight','मध्यरात्र'
  )),
  ('ne', jsonb_build_object(
    'mode.combat','लडाइँ','mode.dialogue','संवाद','mode.exploration','अन्वेषण','mode.travel','यात्रा','mode.rest','आराम','mode.intimacy','निकटता',
    'stat.STR','बल','stat.DEX','फुर्ती','stat.CON','सहन','stat.INT','बुद्धि','stat.WIS','विवेक','stat.CHA','आकर्षण',
    'skill.acrobatics','कलाबाजी','skill.animal_handling','जनावर सम्हाल्ने','skill.arcana','रहस्यविद्या','skill.athletics','एथलेटिक्स','skill.deception','छल','skill.history','इतिहास','skill.insight','अन्तर्दृष्टि','skill.intimidation','धम्की','skill.investigation','जाँच','skill.medicine','चिकित्सा','skill.nature','प्रकृति','skill.perception','धारणा','skill.performance','प्रदर्शन','skill.persuasion','मनाउनु','skill.religion','धर्म','skill.sleight_of_hand','हातको चतुराइ','skill.stealth','गोप्यता','skill.survival','बाँच्ने कला',
    'scene.day_label','दिन {day}','time.dawn','बिहानी','time.morning','बिहान','time.noon','मध्यान्ह','time.afternoon','अपराह्न','time.dusk','साँझ','time.night','रात','time.midnight','मध्यरात'
  )),
  ('bn', jsonb_build_object(
    'mode.combat','যুদ্ধ','mode.dialogue','সংলাপ','mode.exploration','অন্বেষণ','mode.travel','ভ্রমণ','mode.rest','বিশ্রাম','mode.intimacy','ঘনিষ্ঠতা',
    'stat.STR','বল','stat.DEX','ক্ষিপ্র','stat.CON','সহন','stat.INT','বুদ্ধি','stat.WIS','প্রজ্ঞা','stat.CHA','করিশ্মা',
    'skill.acrobatics','কসরত','skill.animal_handling','প্রাণী সামলানো','skill.arcana','গূঢ়বিদ্যা','skill.athletics','অ্যাথলেটিকস','skill.deception','প্রতারণা','skill.history','ইতিহাস','skill.insight','অন্তর্দৃষ্টি','skill.intimidation','ভয় দেখানো','skill.investigation','তদন্ত','skill.medicine','চিকিৎসা','skill.nature','প্রকৃতি','skill.perception','উপলব্ধি','skill.performance','অভিনয়','skill.persuasion','প্ররোচনা','skill.religion','ধর্ম','skill.sleight_of_hand','হাতসাফাই','skill.stealth','গোপনতা','skill.survival','বেঁচে থাকা',
    'scene.day_label','দিন {day}','time.dawn','ভোর','time.morning','সকাল','time.noon','দুপুর','time.afternoon','বিকেল','time.dusk','সন্ধ্যা','time.night','রাত','time.midnight','মধ্যরাত'
  )),
  ('th', jsonb_build_object(
    'mode.combat','ต่อสู้','mode.dialogue','สนทนา','mode.exploration','สำรวจ','mode.travel','เดินทาง','mode.rest','พักผ่อน','mode.intimacy','ความใกล้ชิด',
    'stat.STR','กำลัง','stat.DEX','คล่อง','stat.CON','ทนทาน','stat.INT','ปัญญา','stat.WIS','ญาณ','stat.CHA','เสน่ห์',
    'skill.acrobatics','กายกรรม','skill.animal_handling','ดูแลสัตว์','skill.arcana','อาคม','skill.athletics','กรีฑา','skill.deception','หลอกลวง','skill.history','ประวัติศาสตร์','skill.insight','อ่านใจ','skill.intimidation','ข่มขู่','skill.investigation','สืบสวน','skill.medicine','การแพทย์','skill.nature','ธรรมชาติ','skill.perception','การรับรู้','skill.performance','การแสดง','skill.persuasion','โน้มน้าว','skill.religion','ศาสนา','skill.sleight_of_hand','มือไว','skill.stealth','ลอบเร้น','skill.survival','เอาชีวิตรอด',
    'scene.day_label','วันที่ {day}','time.dawn','รุ่งอรุณ','time.morning','เช้า','time.noon','เที่ยง','time.afternoon','บ่าย','time.dusk','พลบค่ำ','time.night','กลางคืน','time.midnight','เที่ยงคืน'
  )),
  ('el', jsonb_build_object(
    'mode.combat','Μάχη','mode.dialogue','Διάλογος','mode.exploration','Εξερεύνηση','mode.travel','Ταξίδι','mode.rest','Ανάπαυση','mode.intimacy','Οικειότητα',
    'stat.STR','ΔΥΝ','stat.DEX','ΕΠΙ','stat.CON','ΑΝΤ','stat.INT','ΝΟΗ','stat.WIS','ΣΟΦ','stat.CHA','ΧΑΡ',
    'skill.acrobatics','Ακροβατικά','skill.animal_handling','Χειρισμός ζώων','skill.arcana','Αρκάνα','skill.athletics','Αθλητισμός','skill.deception','Εξαπάτηση','skill.history','Ιστορία','skill.insight','Διορατικότητα','skill.intimidation','Εκφοβισμός','skill.investigation','Έρευνα','skill.medicine','Ιατρική','skill.nature','Φύση','skill.perception','Αντίληψη','skill.performance','Παράσταση','skill.persuasion','Πειθώ','skill.religion','Θρησκεία','skill.sleight_of_hand','Ταχυδακτυλουργία','skill.stealth','Απόκρυψη','skill.survival','Επιβίωση',
    'scene.day_label','Ημέρα {day}','time.dawn','Αυγή','time.morning','Πρωί','time.noon','Μεσημέρι','time.afternoon','Απόγευμα','time.dusk','Σούρουπο','time.night','Νύχτα','time.midnight','Μεσάνυχτα'
  )),
  ('hy', jsonb_build_object(
    'mode.combat','Մարտ','mode.dialogue','Երկխոսություն','mode.exploration','Հետազոտում','mode.travel','Ճամփորդություն','mode.rest','Հանգիստ','mode.intimacy','Մտերմություն',
    'stat.STR','Ուժ','stat.DEX','Ճկն','stat.CON','Դիմ','stat.INT','Խել','stat.WIS','Իմստ','stat.CHA','Հմայք',
    'skill.acrobatics','Ակրոբատիկա','skill.animal_handling','Կենդանիներ','skill.arcana','Արկանա','skill.athletics','Աթլետիկա','skill.deception','Խաբեություն','skill.history','Պատմություն','skill.insight','Ներատեսություն','skill.intimidation','Սպառնալիք','skill.investigation','Հետաքննություն','skill.medicine','Բժշկություն','skill.nature','Բնություն','skill.perception','Ընկալում','skill.performance','Կատարում','skill.persuasion','Համոզում','skill.religion','Կրոն','skill.sleight_of_hand','Ձեռքի ճարպկություն','skill.stealth','Թաքունություն','skill.survival','Գոյատևում',
    'scene.day_label','Օր {day}','time.dawn','Լուսաբաց','time.morning','Առավոտ','time.noon','Կեսօր','time.afternoon','Կեսօրից հետո','time.dusk','Մթնշաղ','time.night','Գիշեր','time.midnight','Կեսգիշեր'
  )),
  ('ka', jsonb_build_object(
    'mode.combat','ბრძოლა','mode.dialogue','დიალოგი','mode.exploration','კვლევა','mode.travel','მოგზაურობა','mode.rest','დასვენება','mode.intimacy','სიახლოვე',
    'stat.STR','ძალა','stat.DEX','მოქნ','stat.CON','გამძლ','stat.INT','ინტ','stat.WIS','სიბრ','stat.CHA','ქარ',
    'skill.acrobatics','აკრობატიკა','skill.animal_handling','ცხოველებთან მოპყრობა','skill.arcana','არკანა','skill.athletics','ათლეტიკა','skill.deception','მოტყუება','skill.history','ისტორია','skill.insight','გამჭრიახობა','skill.intimidation','დაშინება','skill.investigation','გამოძიება','skill.medicine','მედიცინა','skill.nature','ბუნება','skill.perception','აღქმა','skill.performance','წარდგენა','skill.persuasion','დარწმუნება','skill.religion','რელიგია','skill.sleight_of_hand','ხელის სისწრაფე','skill.stealth','ჩუმად მოძრაობა','skill.survival','გადარჩენა',
    'scene.day_label','დღე {day}','time.dawn','განთიადი','time.morning','დილა','time.noon','შუადღე','time.afternoon','ნაშუადღევი','time.dusk','ბინდი','time.night','ღამე','time.midnight','შუაღამე'
  )),
  ('ko', jsonb_build_object(
    'mode.combat','전투','mode.dialogue','대화','mode.exploration','탐험','mode.travel','여행','mode.rest','휴식','mode.intimacy','친밀감',
    'stat.STR','힘','stat.DEX','민첩','stat.CON','건강','stat.INT','지능','stat.WIS','지혜','stat.CHA','매력',
    'skill.acrobatics','곡예','skill.animal_handling','동물 조련','skill.arcana','비전학','skill.athletics','운동','skill.deception','기만','skill.history','역사','skill.insight','통찰','skill.intimidation','위협','skill.investigation','조사','skill.medicine','의학','skill.nature','자연','skill.perception','감지','skill.performance','공연','skill.persuasion','설득','skill.religion','종교','skill.sleight_of_hand','손재주','skill.stealth','은신','skill.survival','생존',
    'scene.day_label','{day}일','time.dawn','새벽','time.morning','아침','time.noon','정오','time.afternoon','오후','time.dusk','황혼','time.night','밤','time.midnight','자정'
  )),
  ('ja', jsonb_build_object(
    'mode.combat','戦闘','mode.dialogue','会話','mode.exploration','探索','mode.travel','移動','mode.rest','休息','mode.intimacy','親密',
    'stat.STR','筋力','stat.DEX','敏捷','stat.CON','耐久','stat.INT','知力','stat.WIS','判断','stat.CHA','魅力',
    'skill.acrobatics','軽業','skill.animal_handling','動物使い','skill.arcana','魔法学','skill.athletics','運動','skill.deception','ペテン','skill.history','歴史','skill.insight','看破','skill.intimidation','威圧','skill.investigation','捜査','skill.medicine','医術','skill.nature','自然','skill.perception','知覚','skill.performance','芸能','skill.persuasion','説得','skill.religion','宗教','skill.sleight_of_hand','手先の早業','skill.stealth','隠密','skill.survival','生存',
    'scene.day_label','{day}日目','time.dawn','夜明け','time.morning','朝','time.noon','正午','time.afternoon','午後','time.dusk','夕暮れ','time.night','夜','time.midnight','真夜中'
  )),
  ('zh', jsonb_build_object(
    'mode.combat','战斗','mode.dialogue','对话','mode.exploration','探索','mode.travel','旅行','mode.rest','休息','mode.intimacy','亲密',
    'stat.STR','力量','stat.DEX','敏捷','stat.CON','体质','stat.INT','智力','stat.WIS','感知','stat.CHA','魅力',
    'skill.acrobatics','杂技','skill.animal_handling','驯兽','skill.arcana','奥秘','skill.athletics','运动','skill.deception','欺瞒','skill.history','历史','skill.insight','洞悉','skill.intimidation','威吓','skill.investigation','调查','skill.medicine','医药','skill.nature','自然','skill.perception','察觉','skill.performance','表演','skill.persuasion','游说','skill.religion','宗教','skill.sleight_of_hand','巧手','skill.stealth','隐匿','skill.survival','生存',
    'scene.day_label','第 {day} 天','time.dawn','黎明','time.morning','早晨','time.noon','正午','time.afternoon','下午','time.dusk','黄昏','time.night','夜晚','time.midnight','午夜'
  ))
)
INSERT INTO i18n_translations (key, lang, value)
SELECT entry.key, packs.lang, entry.value
FROM packs
CROSS JOIN LATERAL jsonb_each_text(packs.entries) AS entry(key, value)
ON CONFLICT (key, lang) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = now();
