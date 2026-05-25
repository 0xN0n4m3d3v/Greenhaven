-- Spec 110 - loading quote packs for every supported UI language.

WITH packs(lang, entries) AS (
  VALUES
  ('uk', jsonb_build_object(
    'quote.greenhaven.1','Латунні сутінки довго палають над Greenhaven; навіть тіні мають свої історії.',
    'quote.greenhaven.2','У кожної монети є ливарник. У кожного ливарника є борг.',
    'quote.greenhaven.3','Місто можна покинути. Його присмак - ні.',
    'quote.greenhaven.4','Кістки падають. Історія стає тим, що ти з них зробив.'
  )),
  ('bg', jsonb_build_object(
    'quote.greenhaven.1','Месинговият здрач гори дълго над Greenhaven; дори сенките имат истории.',
    'quote.greenhaven.2','Всяка монета има леяр. Всеки леяр има дълг.',
    'quote.greenhaven.3','Можеш да напуснеш град. Не можеш да напуснеш вкуса му.',
    'quote.greenhaven.4','Заровете падат. Историята е това, което направиш от тях.'
  )),
  ('sr', jsonb_build_object(
    'quote.greenhaven.1','Месингани сумрак дуго гори над Greenhavenом; чак и сенке имају приче.',
    'quote.greenhaven.2','Сваки новчић има ливца. Сваки ливац има дуг.',
    'quote.greenhaven.3','Можеш напустити град. Његов укус не можеш.',
    'quote.greenhaven.4','Коцке падају. Прича је оно што од њих направиш.'
  )),
  ('es', jsonb_build_object(
    'quote.greenhaven.1','El crepúsculo de latón arde largo sobre Greenhaven; hasta las sombras tienen historias.',
    'quote.greenhaven.2','Cada moneda tiene un fundidor. Cada fundidor tiene una deuda.',
    'quote.greenhaven.3','Puedes dejar una ciudad. No puedes dejar su sabor.',
    'quote.greenhaven.4','Los dados caen. La historia es lo que haces con ellos.'
  )),
  ('fr', jsonb_build_object(
    'quote.greenhaven.1','Le crépuscule couleur laiton brûle longtemps sur Greenhaven; même les ombres ont des histoires.',
    'quote.greenhaven.2','Chaque pièce a son fondeur. Chaque fondeur a sa dette.',
    'quote.greenhaven.3','On peut quitter une ville. On ne quitte pas son goût.',
    'quote.greenhaven.4','Les dés tombent. Lhistoire est ce que tu en fais.'
  )),
  ('de', jsonb_build_object(
    'quote.greenhaven.1','Die messinghelle Dämmerung brennt lange über Greenhaven; selbst die Schatten haben Geschichten.',
    'quote.greenhaven.2','Jede Münze hat einen Gießer. Jeder Gießer hat eine Schuld.',
    'quote.greenhaven.3','Du kannst eine Stadt verlassen. Ihren Geschmack nicht.',
    'quote.greenhaven.4','Die Würfel fallen. Die Geschichte ist, was du daraus machst.'
  )),
  ('it', jsonb_build_object(
    'quote.greenhaven.1','Il crepuscolo color ottone brucia a lungo su Greenhaven; anche le ombre hanno storie.',
    'quote.greenhaven.2','Ogni moneta ha un fonditore. Ogni fonditore ha un debito.',
    'quote.greenhaven.3','Puoi lasciare una città. Non puoi lasciare il suo sapore.',
    'quote.greenhaven.4','I dadi cadono. La storia è ciò che ne fai.'
  )),
  ('pt', jsonb_build_object(
    'quote.greenhaven.1','O crepúsculo de latão arde por muito tempo sobre Greenhaven; até as sombras têm histórias.',
    'quote.greenhaven.2','Toda moeda tem um fundidor. Todo fundidor tem uma dívida.',
    'quote.greenhaven.3','Você pode deixar uma cidade. Não pode deixar seu gosto.',
    'quote.greenhaven.4','Os dados caem. A história é o que você faz deles.'
  )),
  ('ro', jsonb_build_object(
    'quote.greenhaven.1','Amurgul de alamă arde mult peste Greenhaven; chiar și umbrele au povești.',
    'quote.greenhaven.2','Fiecare monedă are un turnător. Fiecare turnător are o datorie.',
    'quote.greenhaven.3','Poți părăsi un oraș. Nu îi poți părăsi gustul.',
    'quote.greenhaven.4','Zarurile cad. Povestea este ce faci tu din ele.'
  )),
  ('he', jsonb_build_object(
    'quote.greenhaven.1','דמדומי פליז בוערים זמן רב מעל Greenhaven; אפילו לצללים יש סיפורים.',
    'quote.greenhaven.2','לכל מטבע יש יוצק. לכל יוצק יש חוב.',
    'quote.greenhaven.3','אפשר לעזוב עיר. אי אפשר לעזוב את טעמה.',
    'quote.greenhaven.4','הקוביות נופלות. הסיפור הוא מה שעשית מהן.'
  )),
  ('ar', jsonb_build_object(
    'quote.greenhaven.1','يبقى شفق النحاس مشتعلا طويلا فوق Greenhaven؛ حتى الظلال لها حكايات.',
    'quote.greenhaven.2','لكل عملة صاهر. ولكل صاهر دين.',
    'quote.greenhaven.3','يمكنك مغادرة مدينة. لا يمكنك مغادرة مذاقها.',
    'quote.greenhaven.4','تسقط النرد. والقصة هي ما تصنعه منها.'
  )),
  ('fa', jsonb_build_object(
    'quote.greenhaven.1','شفق برنجی دیرزمانی بر فراز Greenhaven می‌سوزد؛ حتی سایه‌ها نیز داستان دارند.',
    'quote.greenhaven.2','هر سکه‌ای ذوبگری دارد. هر ذوبگری بدهی دارد.',
    'quote.greenhaven.3','می‌توانی شهری را ترک کنی. مزه‌اش را نه.',
    'quote.greenhaven.4','تاس‌ها می‌افتند. داستان همان چیزی است که تو از آنها می‌سازی.'
  )),
  ('ur', jsonb_build_object(
    'quote.greenhaven.1','پیتل سا شفق Greenhaven پر دیر تک جلتا ہے؛ سائے بھی کہانیاں رکھتے ہیں.',
    'quote.greenhaven.2','ہر سکے کا ایک ڈھلائی گر ہے۔ ہر ڈھلائی گر کا ایک قرض ہے.',
    'quote.greenhaven.3','تم شہر چھوڑ سکتے ہو۔ اس کا ذائقہ نہیں.',
    'quote.greenhaven.4','پانسے گرتے ہیں۔ کہانی وہ ہے جو تم ان سے بناتے ہو.'
  )),
  ('hi', jsonb_build_object(
    'quote.greenhaven.1','पीतल-सी सांझ Greenhaven पर देर तक जलती है; परछाइयों के पास भी कहानियां हैं.',
    'quote.greenhaven.2','हर सिक्के का एक ढालने वाला होता है. हर ढालने वाले का एक कर्ज होता है.',
    'quote.greenhaven.3','तुम शहर छोड़ सकते हो. उसका स्वाद नहीं.',
    'quote.greenhaven.4','पासे गिरते हैं. कहानी वही है जो तुम उनसे बनाते हो.'
  )),
  ('mr', jsonb_build_object(
    'quote.greenhaven.1','पितळी संधिप्रकाश Greenhaven वर बराच वेळ जळतो; सावल्यांनाही कथा असतात.',
    'quote.greenhaven.2','प्रत्येक नाण्याचा घडवणारा असतो. प्रत्येक घडवणाऱ्यावर कर्ज असते.',
    'quote.greenhaven.3','शहर सोडता येते. त्याची चव नाही.',
    'quote.greenhaven.4','फासे पडतात. कथा म्हणजे तू त्यांच्यापासून काय घडवतोस.'
  )),
  ('ne', jsonb_build_object(
    'quote.greenhaven.1','पित्तलजस्तो साँझ Greenhaven माथि लामो समय बल्छ; छायासँग पनि कथा हुन्छन्.',
    'quote.greenhaven.2','हरेक सिक्काको एक ढाल्ने मान्छे हुन्छ. हरेक ढाल्ने मान्छेको ऋण हुन्छ.',
    'quote.greenhaven.3','तिमी शहर छोड्न सक्छौ. त्यसको स्वाद छोड्न सक्दैनौ.',
    'quote.greenhaven.4','पासा खस्छन्. कथा तिमीले तिनबाट बनाएको कुरा हो.'
  )),
  ('bn', jsonb_build_object(
    'quote.greenhaven.1','পিতলের আলোয় সন্ধ্যা Greenhaven-এর ওপর দীর্ঘক্ষণ জ্বলে; ছায়ারও গল্প আছে.',
    'quote.greenhaven.2','প্রতিটি মুদ্রার একজন ঢালাইকারী আছে. প্রতিটি ঢালাইকারীর ঋণ আছে.',
    'quote.greenhaven.3','তুমি শহর ছাড়তে পারো. তার স্বাদ নয়.',
    'quote.greenhaven.4','পাশা পড়ে. গল্প হলো তুমি সেগুলো দিয়ে যা বানাও.'
  )),
  ('th', jsonb_build_object(
    'quote.greenhaven.1','พลบค่ำสีทองเหลืองเผาไหม้เหนือ Greenhaven ยาวนาน แม้เงาก็มีเรื่องเล่า.',
    'quote.greenhaven.2','เหรียญทุกเหรียญมีคนหล่อมัน คนหล่อทุกคนมีหนี้.',
    'quote.greenhaven.3','คุณจากเมืองไปได้ แต่จากรสชาติของมันไม่ได้.',
    'quote.greenhaven.4','ลูกเต๋าตกลง เรื่องราวคือสิ่งที่คุณสร้างจากมัน.'
  )),
  ('el', jsonb_build_object(
    'quote.greenhaven.1','Το μπρούτζινο σούρουπο καίει για πολύ πάνω από το Greenhaven· ακόμη και οι σκιές έχουν ιστορίες.',
    'quote.greenhaven.2','Κάθε νόμισμα έχει έναν χυτή. Κάθε χυτής έχει ένα χρέος.',
    'quote.greenhaven.3','Μπορείς να φύγεις από μια πόλη. Δεν μπορείς να φύγεις από τη γεύση της.',
    'quote.greenhaven.4','Τα ζάρια πέφτουν. Η ιστορία είναι αυτό που έφτιαξες από αυτά.'
  )),
  ('hy', jsonb_build_object(
    'quote.greenhaven.1','Պղնձագույն մթնշաղը երկար է վառվում Greenhaven-ի վրա. նույնիսկ ստվերներն ունեն պատմություններ.',
    'quote.greenhaven.2','Յուրաքանչյուր մետաղադրամ ունի ձուլող. յուրաքանչյուր ձուլող ունի պարտք.',
    'quote.greenhaven.3','Քաղաքը կարող ես լքել. նրա համը՝ ոչ.',
    'quote.greenhaven.4','Զառերը ընկնում են. պատմությունն այն է, ինչ դու ստեղծում ես դրանցից.'
  )),
  ('ka', jsonb_build_object(
    'quote.greenhaven.1','სპილენძისფერი ბინდი დიდხანს იწვის Greenhaven-ის თავზე; ჩრდილებსაც აქვთ ამბები.',
    'quote.greenhaven.2','ყოველ მონეტას მღვრელი ჰყავს. ყოველ მღვრელს ვალი აქვს.',
    'quote.greenhaven.3','ქალაქის დატოვება შეგიძლია. მისი გემოსი - არა.',
    'quote.greenhaven.4','კამათლები ეცემა. ამბავი ის არის, რასაც მათგან შექმნი.'
  )),
  ('ko', jsonb_build_object(
    'quote.greenhaven.1','놋쇠빛 황혼은 Greenhaven 위에서 오래 타오른다. 그림자들조차 이야기를 품고 있다.',
    'quote.greenhaven.2','모든 동전에는 주조자가 있다. 모든 주조자에게는 빚이 있다.',
    'quote.greenhaven.3','도시는 떠날 수 있다. 그 맛은 떠날 수 없다.',
    'quote.greenhaven.4','주사위가 떨어진다. 이야기는 네가 그것들로 만든 것이다.'
  )),
  ('ja', jsonb_build_object(
    'quote.greenhaven.1','真鍮色の黄昏は Greenhaven の上で長く燃える。影にさえ物語がある。',
    'quote.greenhaven.2','すべての硬貨には鋳造者がいる。すべての鋳造者には借りがある。',
    'quote.greenhaven.3','街を去ることはできる。その味までは去れない。',
    'quote.greenhaven.4','ダイスは転がる。物語は、君がそこから作ったものだ。'
  )),
  ('zh', jsonb_build_object(
    'quote.greenhaven.1','黄铜色的暮光在 Greenhaven 上空久久燃烧；连影子也有故事。',
    'quote.greenhaven.2','每枚硬币都有铸造者。每个铸造者都有债。',
    'quote.greenhaven.3','你可以离开一座城，却离不开它的味道。',
    'quote.greenhaven.4','骰子落下。故事就是你用它们做成的东西。'
  ))
)
INSERT INTO i18n_translations (key, lang, value)
SELECT entry.key, packs.lang, entry.value
FROM packs
CROSS JOIN LATERAL jsonb_each_text(packs.entries) AS entry(key, value)
ON CONFLICT (key, lang) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = now();
