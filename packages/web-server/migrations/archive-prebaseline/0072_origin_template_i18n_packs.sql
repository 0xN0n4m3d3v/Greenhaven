-- Spec 110 - language packs for cartridge_meta.origin_templates cards.

WITH origin_i18n(id, pack) AS (
  VALUES
  ('tiefling-charmer', jsonb_build_object(
    'label', jsonb_build_object(
      'en', $gh$The Charmer$gh$,
      'ru', $gh$Очаровательница$gh$,
      'uk', $gh$Чарівниця$gh$,
      'bg', $gh$Омайницата$gh$,
      'sr', $gh$Шармерка$gh$,
      'es', $gh$La Encantadora$gh$,
      'fr', $gh$La Charmeuse$gh$,
      'de', $gh$Die Verführerin$gh$,
      'it', $gh$L'Incantatrice$gh$,
      'pt', $gh$A Encantadora$gh$,
      'ro', $gh$Fermecătoarea$gh$,
      'he', $gh$המקסימה$gh$,
      'ar', $gh$الفاتنة$gh$,
      'fa', $gh$دلربا$gh$,
      'ur', $gh$دلکش$gh$,
      'hi', $gh$मोहिनी$gh$,
      'mr', $gh$मोहिनी$gh$,
      'ne', $gh$मोहिनी$gh$,
      'bn', $gh$মোহিনী$gh$,
      'th', $gh$ผู้ล่อลวง$gh$,
      'el', $gh$Η Γητεύτρα$gh$,
      'hy', $gh$Հմայողը$gh$,
      'ka', $gh$მომხიბვლელი$gh$,
      'ko', $gh$매혹자$gh$,
      'ja', $gh$魅了者$gh$,
      'zh', $gh$魅惑者$gh$
    ),
    'blurb', jsonb_build_object(
      'en', $gh$Tiefling born with succubus heritage too close to the surface. Trades in attention.$gh$,
      'ru', $gh$Тифлинг с наследием суккуба слишком близко к поверхности. Торгует вниманием.$gh$,
      'uk', $gh$Тифлінг зі спадком сукуба надто близько до поверхні. Торгує увагою.$gh$,
      'bg', $gh$Тифлинг с наследство на сукуб твърде близо до повърхността. Търгува с внимание.$gh$,
      'sr', $gh$Тифлинг са сукубским наслеђем преблизу површини. Тргује пажњом.$gh$,
      'es', $gh$Tiefling nacida con herencia de súcubo demasiado cerca de la piel. Comercia con atención.$gh$,
      'fr', $gh$Tieffeline née avec un héritage de succube trop proche de la surface. Marchande l'attention.$gh$,
      'de', $gh$Tiefling mit Sukkubus-Erbe dicht unter der Haut. Handelt mit Aufmerksamkeit.$gh$,
      'it', $gh$Tiefling nata con sangue di succube troppo vicino alla superficie. Commercia in attenzioni.$gh$,
      'pt', $gh$Tiefling nascida com herança de súcubo perto demais da pele. Negocia atenção.$gh$,
      'ro', $gh$Tiefling născută cu moștenire de succub prea aproape de suprafață. Negociază atenție.$gh$,
      'he', $gh$טיפלינג שנולדה עם מורשת סוקובוס קרובה מדי לפני השטח. סוחרת בתשומת לב.$gh$,
      'ar', $gh$تيفلينغ وُلدت وإرث الساكيوبوس قريب جدا من السطح. تتاجر بالانتباه.$gh$,
      'fa', $gh$تیفلینگی که میراث ساکوبوس در او بیش از حد نزدیک به سطح است. با توجه معامله می کند.$gh$,
      'ur', $gh$ایسی ٹائیفلنگ جس میں سکوبس ورثہ سطح کے بہت قریب ہے۔ توجہ کا سودا کرتی ہے۔$gh$,
      'hi', $gh$टाइफलिंग जिसके भीतर सक्यूबस विरासत सतह के बहुत करीब है। ध्यान में सौदा करती है।$gh$,
      'mr', $gh$सक्यूबस वारसा पृष्ठभागाजवळ असलेली टायफलिंग. लक्षाचे सौदे करते.$gh$,
      'ne', $gh$सक्युबस विरासत सतह नजिकै भएको टाइफलिङ। ध्यानको कारोबार गर्छे।$gh$,
      'bn', $gh$সাকিউবাস উত্তরাধিকার খুব কাছাকাছি নিয়ে জন্মানো টাইফলিং। মনোযোগ নিয়েই তার বেচাকেনা।$gh$,
      'th', $gh$ไทฟลิงที่สายเลือดซัคคิวบัสอยู่ใกล้ผิวเกินไป ค้าขายด้วยความสนใจของผู้คน$gh$,
      'el', $gh$Τίφλινγκ με κληρονομιά σούκουμπου πολύ κοντά στην επιφάνεια. Εμπορεύεται την προσοχή.$gh$,
      'hy', $gh$Թիֆլինգ, որի սուկուբի ժառանգությունը չափազանց մոտ է մակերեսին։ Գործ ունի ուշադրության հետ։$gh$,
      'ka', $gh$ტიფლინგი, რომლის სუკუბის მემკვიდრეობა ზედაპირთან ძალიან ახლოსაა. ყურადღებით ვაჭრობს.$gh$,
      'ko', $gh$서큐버스의 혈통이 너무 가까이 드러난 티플링. 시선과 관심을 거래한다.$gh$,
      'ja', $gh$サキュバスの血が表面に近すぎるティーフリング。注目を取引する。$gh$,
      'zh', $gh$魅魔血脉过于贴近表层的提夫林。以注意力为交易。$gh$
    )
  )),
  ('goblin-fixer', jsonb_build_object(
    'label', jsonb_build_object(
      'en', $gh$The Fixer$gh$,
      'ru', $gh$Решала$gh$,
      'uk', $gh$Рішала$gh$,
      'bg', $gh$Уредникът$gh$,
      'sr', $gh$Сређивач$gh$,
      'es', $gh$El Arreglador$gh$,
      'fr', $gh$L'Arrangeur$gh$,
      'de', $gh$Der Beschaffer$gh$,
      'it', $gh$Il Sistematore$gh$,
      'pt', $gh$O Facilitador$gh$,
      'ro', $gh$Aranjatorul$gh$,
      'he', $gh$המסדר$gh$,
      'ar', $gh$المصلح$gh$,
      'fa', $gh$کارچاق کن$gh$,
      'ur', $gh$کام بنانے والا$gh$,
      'hi', $gh$जुगाड़ू$gh$,
      'mr', $gh$जुगाडू$gh$,
      'ne', $gh$जुगाडु$gh$,
      'bn', $gh$ব্যবস্থাকারী$gh$,
      'th', $gh$ผู้จัดการปัญหา$gh$,
      'el', $gh$Ο Μεσολαβητής$gh$,
      'hy', $gh$Գործ Կարգավորողը$gh$,
      'ka', $gh$საქმის მომგვარებელი$gh$,
      'ko', $gh$해결사$gh$,
      'ja', $gh$始末屋$gh$,
      'zh', $gh$摆平者$gh$
    ),
    'blurb', jsonb_build_object(
      'en', $gh$Quickgrin Lane local. Knows where every coin lands. Few qualms.$gh$,
      'ru', $gh$Местный с Quickgrin Lane. Знает, куда падает каждая монета. Сомневается редко.$gh$,
      'uk', $gh$Місцевий із Quickgrin Lane. Знає, куди падає кожна монета. Вагань майже не має.$gh$,
      'bg', $gh$Местен от Quickgrin Lane. Знае къде пада всяка монета. Има малко скрупули.$gh$,
      'sr', $gh$Мештанин из Quickgrin Lane. Зна где пада сваки новчић. Мало се двоуми.$gh$,
      'es', $gh$Habitante de Quickgrin Lane. Sabe dónde cae cada moneda. Pocos escrúpulos.$gh$,
      'fr', $gh$Gens du coin de Quickgrin Lane. Sait où tombe chaque pièce. Peu de scrupules.$gh$,
      'de', $gh$Einheimischer der Quickgrin Lane. Weiß, wo jede Münze landet. Wenige Skrupel.$gh$,
      'it', $gh$Locale di Quickgrin Lane. Sa dove finisce ogni moneta. Pochi scrupoli.$gh$,
      'pt', $gh$Morador de Quickgrin Lane. Sabe onde cada moeda cai. Poucos escrúpulos.$gh$,
      'ro', $gh$Localnic din Quickgrin Lane. Știe unde ajunge fiecare monedă. Puține scrupule.$gh$,
      'he', $gh$מקומי מ-Quickgrin Lane. יודע איפה נוחת כל מטבע. מעט היסוסים.$gh$,
      'ar', $gh$محلي من Quickgrin Lane. يعرف أين تسقط كل عملة. قليل التردد.$gh$,
      'fa', $gh$محلی Quickgrin Lane. می داند هر سکه کجا می افتد. تردید کمی دارد.$gh$,
      'ur', $gh$Quickgrin Lane کا مقامی۔ جانتا ہے ہر سکہ کہاں گرتا ہے۔ کم ہی ہچکچاتا ہے۔$gh$,
      'hi', $gh$Quickgrin Lane का स्थानीय। जानता है हर सिक्का कहाँ गिरता है। झिझक बहुत कम।$gh$,
      'mr', $gh$Quickgrin Laneचा स्थानिक. प्रत्येक नाणे कुठे पडते हे जाणतो. शंका कमी.$gh$,
      'ne', $gh$Quickgrin Lane को स्थानीय। हरेक सिक्का कहाँ खस्छ जान्छ। हिचकिचाहट थोरै।$gh$,
      'bn', $gh$Quickgrin Lane-এর স্থানীয়। প্রতিটি মুদ্রা কোথায় পড়ে জানে। দ্বিধা কম।$gh$,
      'th', $gh$คนถิ่น Quickgrin Lane รู้ว่าเหรียญทุกเหรียญตกไปที่ใด ลังเลน้อยมาก$gh$,
      'el', $gh$Ντόπιος της Quickgrin Lane. Ξέρει πού πέφτει κάθε νόμισμα. Λίγοι ενδοιασμοί.$gh$,
      'hy', $gh$Quickgrin Lane-ի տեղացի։ Գիտի, թե ուր է ընկնում ամեն մետաղադրամ։ Քիչ է խղճահարվում։$gh$,
      'ka', $gh$Quickgrin Lane-ის ადგილობრივი. იცის, სად ეცემა ყოველი მონეტა. იშვიათად ყოყმანობს.$gh$,
      'ko', $gh$Quickgrin Lane 토박이. 동전 하나가 어디 떨어지는지 안다. 망설임은 적다.$gh$,
      'ja', $gh$Quickgrin Laneの地元民。すべての硬貨がどこへ落ちるか知っている。ためらいは少ない。$gh$,
      'zh', $gh$Quickgrin Lane本地人。知道每一枚硬币落向哪里。很少犹豫。$gh$
    )
  )),
  ('human-veteran', jsonb_build_object(
    'label', jsonb_build_object(
      'en', $gh$The Veteran$gh$,
      'ru', $gh$Ветеран$gh$,
      'uk', $gh$Ветеран$gh$,
      'bg', $gh$Ветеранът$gh$,
      'sr', $gh$Ветеран$gh$,
      'es', $gh$El Veterano$gh$,
      'fr', $gh$Le Vétéran$gh$,
      'de', $gh$Der Veteran$gh$,
      'it', $gh$Il Veterano$gh$,
      'pt', $gh$O Veterano$gh$,
      'ro', $gh$Veteranul$gh$,
      'he', $gh$הוותיק$gh$,
      'ar', $gh$المحارب القديم$gh$,
      'fa', $gh$کهنه سرباز$gh$,
      'ur', $gh$تجربہ کار سپاہی$gh$,
      'hi', $gh$योद्धा-वयोवृद्ध$gh$,
      'mr', $gh$जुना योद्धा$gh$,
      'ne', $gh$अनुभवी योद्धा$gh$,
      'bn', $gh$প্রবীণ যোদ্ধা$gh$,
      'th', $gh$ทหารผ่านศึก$gh$,
      'el', $gh$Ο Βετεράνος$gh$,
      'hy', $gh$Վետերանը$gh$,
      'ka', $gh$ვეტერანი$gh$,
      'ko', $gh$노병$gh$,
      'ja', $gh$古参兵$gh$,
      'zh', $gh$老兵$gh$
    ),
    'blurb', jsonb_build_object(
      'en', $gh$Survived a portal-war. Slow to anger, slower to forgive.$gh$,
      'ru', $gh$Выжил в портальной войне. Медленно гневается, еще медленнее прощает.$gh$,
      'uk', $gh$Вижив у портальній війні. Повільно гнівається, ще повільніше пробачає.$gh$,
      'bg', $gh$Оцелял в портална война. Бавно се гневи, още по-бавно прощава.$gh$,
      'sr', $gh$Преживео је порталски рат. Споро се гневи, још спорије прашта.$gh$,
      'es', $gh$Sobrevivió a una guerra de portales. Tarda en enfadarse y más en perdonar.$gh$,
      'fr', $gh$A survécu à une guerre de portails. Lent à la colère, plus lent encore au pardon.$gh$,
      'de', $gh$Überlebte einen Portal-Krieg. Langsam im Zorn, langsamer im Vergeben.$gh$,
      'it', $gh$Sopravvissuto a una guerra dei portali. Lento all'ira, più lento al perdono.$gh$,
      'pt', $gh$Sobreviveu a uma guerra de portais. Demora a se irar, mais ainda a perdoar.$gh$,
      'ro', $gh$A supraviețuit unui război al portalurilor. Se mânie greu și iartă și mai greu.$gh$,
      'he', $gh$שרד מלחמת שערים. איטי לכעוס, איטי עוד יותר לסלוח.$gh$,
      'ar', $gh$نجا من حرب بوابات. بطيء الغضب، وأبطأ في الغفران.$gh$,
      'fa', $gh$از جنگ دروازه ها جان سالم برد. دیر خشمگین می شود و دیرتر می بخشد.$gh$,
      'ur', $gh$پورٹل جنگ سے بچ نکلا۔ دیر سے غصہ، اس سے دیر سے معافی۔$gh$,
      'hi', $gh$पोर्टल-युद्ध से बचा। गुस्सा देर से, माफी उससे भी देर से।$gh$,
      'mr', $gh$पोर्टल युद्धातून वाचलेला. राग उशिरा, क्षमा आणखी उशिरा.$gh$,
      'ne', $gh$पोर्टल युद्धबाट बाँचेको। रिस ढिलो, क्षमा अझ ढिलो।$gh$,
      'bn', $gh$পোর্টাল-যুদ্ধ থেকে বেঁচে ফিরেছে। রাগে ধীর, ক্ষমায় আরও ধীর।$gh$,
      'th', $gh$รอดจากสงครามประตูมิติ โกรธช้า ให้อภัยช้ากว่านั้น$gh$,
      'el', $gh$Επέζησε από πόλεμο πυλών. Αργεί να θυμώσει, αργεί περισσότερο να συγχωρήσει.$gh$,
      'hy', $gh$Փրկվել է պորտալների պատերազմից։ Դանդաղ է բարկանում, ավելի դանդաղ է ներում։$gh$,
      'ka', $gh$პორტალების ომს გადაურჩა. ნელა ბრაზდება, უფრო ნელა პატიობს.$gh$,
      'ko', $gh$차원문 전쟁에서 살아남았다. 화내는 데 느리고, 용서하는 데 더 느리다.$gh$,
      'ja', $gh$門の戦争を生き延びた。怒るのは遅く、許すのはさらに遅い。$gh$,
      'zh', $gh$从传送门战争中幸存。愤怒很慢，原谅更慢。$gh$
    )
  ))
),
rewritten AS (
  SELECT jsonb_agg(
    CASE
      WHEN origin_i18n.pack IS NULL THEN origin.value
      ELSE origin.value || jsonb_build_object('i18n', origin_i18n.pack)
    END
    ORDER BY origin.ordinality
  ) AS value
  FROM cartridge_meta meta
  CROSS JOIN LATERAL jsonb_array_elements(meta.value) WITH ORDINALITY AS origin(value, ordinality)
  LEFT JOIN origin_i18n ON origin_i18n.id = origin.value->>'id'
  WHERE meta.key = 'origin_templates'
)
UPDATE cartridge_meta
   SET value = rewritten.value
  FROM rewritten
 WHERE cartridge_meta.key = 'origin_templates'
   AND rewritten.value IS NOT NULL;
