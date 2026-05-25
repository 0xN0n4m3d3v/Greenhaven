import {
  normalizeSupportedLanguageCode,
  SUPPORTED_LANGUAGES,
} from './languages';

type ActionTextKey =
  | 'travel.location'
  | 'travel.scene'
  | 'item.look'
  | 'item.check'
  | 'social.persuade'
  | 'social.intimidate'
  | 'social.deceive'
  | 'social.seduce'
  | 'social.insight'
  | 'attack'
  | 'string.spend'
  | 'inspiration.spend';

type ActionVars = Record<string, string | number | null | undefined>;

type ActionTextPack = Record<ActionTextKey, string>;

const EN: ActionTextPack = {
  'travel.location': 'I move to @{name} and look around for hooks, risks, people, and payoff.',
  'travel.scene': 'I enter @{name} and look around for hooks, risks, people, and payoff.',
  'item.look': 'I take a closer look at @{name}.',
  'item.check': 'I examine @{name} closely and try the marked approach.',
  'social.persuade': 'I try to persuade @{name}.',
  'social.intimidate': 'I try to intimidate @{name}.',
  'social.deceive': 'I try to deceive @{name}.',
  'social.seduce': 'I try to seduce @{name}.',
  'social.insight': 'I watch @{name} closely, looking for tells.',
  attack: 'I attack @{name}.',
  'string.spend': 'I lean on what passed between us and spend a String on @{name}.',
  'inspiration.spend': 'I draw on what makes me me and call on Inspiration for the next exchange.',
};

const ACTION_TEXT: Record<string, ActionTextPack> = {
  en: EN,
  ru: {
    'travel.location': 'Иду к @{name} и осматриваюсь: кто здесь, что происходит, где риск и где выгода.',
    'travel.scene': 'Вхожу в @{name} и осматриваюсь: кто здесь, что происходит, где риск и где выгода.',
    'item.look': 'Внимательно осматриваю @{name}.',
    'item.check': 'Внимательно изучаю @{name} и пробую доступный способ.',
    'social.persuade': 'Пытаюсь убедить @{name}.',
    'social.intimidate': 'Пытаюсь запугать @{name}.',
    'social.deceive': 'Пытаюсь обмануть @{name}.',
    'social.seduce': 'Пытаюсь соблазнить @{name}.',
    'social.insight': 'Внимательно наблюдаю за @{name}, ищу слабые места и признаки лжи.',
    attack: 'Атакую @{name}.',
    'string.spend': 'Давлю на то, что между нами произошло, и трачу Струну на @{name}.',
    'inspiration.spend': 'Опираюсь на то, что делает меня собой, и призываю Вдохновение для следующего обмена.',
  },
  uk: {
    'travel.location': 'Іду до @{name} й озираюся: хто тут, що відбувається, де ризик і де вигода.',
    'travel.scene': 'Заходжу в @{name} й озираюся: хто тут, що відбувається, де ризик і де вигода.',
    'item.look': 'Уважно оглядаю @{name}.',
    'item.check': 'Уважно вивчаю @{name} і пробую доступний спосіб.',
    'social.persuade': 'Намагаюся переконати @{name}.',
    'social.intimidate': 'Намагаюся залякати @{name}.',
    'social.deceive': 'Намагаюся обдурити @{name}.',
    'social.seduce': 'Намагаюся спокусити @{name}.',
    'social.insight': 'Пильно спостерігаю за @{name}, шукаючи ознаки брехні.',
    attack: 'Атакую @{name}.',
    'string.spend': 'Тисну на те, що між нами сталося, і витрачаю Струну на @{name}.',
    'inspiration.spend': 'Спираюся на те, що робить мене собою, і кличу Натхнення для наступного обміну.',
  },
  bg: {
    'travel.location': 'Отивам до @{name} и се оглеждам: кой е тук, какво става, къде е рискът и къде е печалбата.',
    'travel.scene': 'Влизам в @{name} и се оглеждам: кой е тук, какво става, къде е рискът и къде е печалбата.',
    'item.look': 'Оглеждам внимателно @{name}.',
    'item.check': 'Проучвам внимателно @{name} и пробвам достъпния подход.',
    'social.persuade': 'Опитвам се да убедя @{name}.',
    'social.intimidate': 'Опитвам се да сплаша @{name}.',
    'social.deceive': 'Опитвам се да измамя @{name}.',
    'social.seduce': 'Опитвам се да съблазня @{name}.',
    'social.insight': 'Наблюдавам @{name} внимателно и търся издайнически знаци.',
    attack: 'Атакувам @{name}.',
    'string.spend': 'Използвам това, което е минало между нас, и харча Струна върху @{name}.',
    'inspiration.spend': 'Опирайки се на това, което ме прави мен, призовавам Вдъхновение за следващата размяна.',
  },
  sr: {
    'travel.location': 'Идем до @{name} и осврћем се: ко је ту, шта се дешава, где је ризик и где је добит.',
    'travel.scene': 'Улазим у @{name} и осврћем се: ко је ту, шта се дешава, где је ризик и где је добит.',
    'item.look': 'Пажљиво разгледам @{name}.',
    'item.check': 'Пажљиво испитујем @{name} и покушавам доступан приступ.',
    'social.persuade': 'Покушавам да убедим @{name}.',
    'social.intimidate': 'Покушавам да заплашим @{name}.',
    'social.deceive': 'Покушавам да преварим @{name}.',
    'social.seduce': 'Покушавам да заведем @{name}.',
    'social.insight': 'Пажљиво посматрам @{name}, тражећи знаке и слабости.',
    attack: 'Нападам @{name}.',
    'string.spend': 'Ослањам се на оно што је прошло између нас и трошим Струну на @{name}.',
    'inspiration.spend': 'Ослањам се на оно што ме чини собом и призивам Инспирацију за следећу размену.',
  },
  es: {
    'travel.location': 'Voy a @{name} y miro alrededor: quién está, qué pasa, dónde hay riesgo y dónde hay ganancia.',
    'travel.scene': 'Entro en @{name} y miro alrededor: quién está, qué pasa, dónde hay riesgo y dónde hay ganancia.',
    'item.look': 'Examino @{name} con atención.',
    'item.check': 'Estudio @{name} con cuidado y pruebo el enfoque disponible.',
    'social.persuade': 'Intento persuadir a @{name}.',
    'social.intimidate': 'Intento intimidar a @{name}.',
    'social.deceive': 'Intento engañar a @{name}.',
    'social.seduce': 'Intento seducir a @{name}.',
    'social.insight': 'Observo a @{name} con atención, buscando señales.',
    attack: 'Ataco a @{name}.',
    'string.spend': 'Presiono sobre lo que pasó entre nosotros y gasto una Cuerda en @{name}.',
    'inspiration.spend': 'Me apoyo en lo que me hace ser yo y uso Inspiración para el siguiente intercambio.',
  },
  fr: {
    'travel.location': 'Je vais vers @{name} et j’observe les lieux: qui est là, ce qui se passe, les risques et les gains.',
    'travel.scene': 'J’entre dans @{name} et j’observe les lieux: qui est là, ce qui se passe, les risques et les gains.',
    'item.look': 'J’examine @{name} attentivement.',
    'item.check': 'J’étudie @{name} avec soin et tente l’approche disponible.',
    'social.persuade': 'J’essaie de persuader @{name}.',
    'social.intimidate': 'J’essaie d’intimider @{name}.',
    'social.deceive': 'J’essaie de tromper @{name}.',
    'social.seduce': 'J’essaie de séduire @{name}.',
    'social.insight': 'J’observe @{name} avec attention, à l’affût d’indices.',
    attack: 'J’attaque @{name}.',
    'string.spend': 'J’appuie sur ce qui s’est passé entre nous et je dépense une Ficelle sur @{name}.',
    'inspiration.spend': 'Je puise dans ce qui me définit et j’appelle l’Inspiration pour le prochain échange.',
  },
  de: {
    'travel.location': 'Ich gehe zu @{name} und sehe mich um: wer hier ist, was geschieht, wo Gefahr und Gewinn liegen.',
    'travel.scene': 'Ich betrete @{name} und sehe mich um: wer hier ist, was geschieht, wo Gefahr und Gewinn liegen.',
    'item.look': 'Ich sehe mir @{name} genau an.',
    'item.check': 'Ich untersuche @{name} sorgfältig und versuche den naheliegenden Ansatz.',
    'social.persuade': 'Ich versuche, @{name} zu überzeugen.',
    'social.intimidate': 'Ich versuche, @{name} einzuschüchtern.',
    'social.deceive': 'Ich versuche, @{name} zu täuschen.',
    'social.seduce': 'Ich versuche, @{name} zu verführen.',
    'social.insight': 'Ich beobachte @{name} genau und suche nach verräterischen Zeichen.',
    attack: 'Ich greife @{name} an.',
    'string.spend': 'Ich nutze das, was zwischen uns war, und gebe einen Faden gegen @{name} aus.',
    'inspiration.spend': 'Ich greife auf das zurück, was mich ausmacht, und rufe Inspiration für den nächsten Austausch an.',
  },
  it: {
    'travel.location': 'Vado verso @{name} e mi guardo intorno: chi c’è, cosa succede, dove sono rischio e guadagno.',
    'travel.scene': 'Entro in @{name} e mi guardo intorno: chi c’è, cosa succede, dove sono rischio e guadagno.',
    'item.look': 'Osservo @{name} con attenzione.',
    'item.check': 'Studio @{name} con cura e provo l’approccio disponibile.',
    'social.persuade': 'Provo a persuadere @{name}.',
    'social.intimidate': 'Provo a intimidire @{name}.',
    'social.deceive': 'Provo a ingannare @{name}.',
    'social.seduce': 'Provo a sedurre @{name}.',
    'social.insight': 'Osservo @{name} con attenzione, cercando segnali.',
    attack: 'Attacco @{name}.',
    'string.spend': 'Faccio leva su ciò che è passato tra noi e spendo una Stringa su @{name}.',
    'inspiration.spend': 'Mi aggrappo a ciò che mi rende me stesso e invoco Ispirazione per il prossimo scambio.',
  },
  pt: {
    'travel.location': 'Vou até @{name} e olho ao redor: quem está aqui, o que acontece, onde há risco e recompensa.',
    'travel.scene': 'Entro em @{name} e olho ao redor: quem está aqui, o que acontece, onde há risco e recompensa.',
    'item.look': 'Examino @{name} com atenção.',
    'item.check': 'Estudo @{name} com cuidado e tento a abordagem disponível.',
    'social.persuade': 'Tento persuadir @{name}.',
    'social.intimidate': 'Tento intimidar @{name}.',
    'social.deceive': 'Tento enganar @{name}.',
    'social.seduce': 'Tento seduzir @{name}.',
    'social.insight': 'Observo @{name} com atenção, procurando sinais.',
    attack: 'Ataco @{name}.',
    'string.spend': 'Uso o que aconteceu entre nós e gasto uma Corda em @{name}.',
    'inspiration.spend': 'Recorro ao que me torna quem sou e invoco Inspiração para a próxima troca.',
  },
  ro: {
    'travel.location': 'Merg la @{name} și privesc în jur: cine e aici, ce se întâmplă, unde sunt riscul și câștigul.',
    'travel.scene': 'Intru în @{name} și privesc în jur: cine e aici, ce se întâmplă, unde sunt riscul și câștigul.',
    'item.look': 'Examinez atent @{name}.',
    'item.check': 'Studiez atent @{name} și încerc abordarea disponibilă.',
    'social.persuade': 'Încerc să conving @{name}.',
    'social.intimidate': 'Încerc să intimidez @{name}.',
    'social.deceive': 'Încerc să înșel @{name}.',
    'social.seduce': 'Încerc să seduc @{name}.',
    'social.insight': 'Îl privesc atent pe @{name}, căutând semne.',
    attack: 'Atac @{name}.',
    'string.spend': 'Apăs pe ce s-a întâmplat între noi și cheltui o Coardă pe @{name}.',
    'inspiration.spend': 'Mă sprijin pe ceea ce mă face eu însumi și chem Inspirația pentru următorul schimb.',
  },
  he: {
    'travel.location': 'אני נע אל @{name} ומביט סביב: מי כאן, מה קורה, איפה הסיכון ואיפה הרווח.',
    'travel.scene': 'אני נכנס אל @{name} ומביט סביב: מי כאן, מה קורה, איפה הסיכון ואיפה הרווח.',
    'item.look': 'אני בוחן היטב את @{name}.',
    'item.check': 'אני בוחן היטב את @{name} ומנסה את הגישה הזמינה.',
    'social.persuade': 'אני מנסה לשכנע את @{name}.',
    'social.intimidate': 'אני מנסה לאיים על @{name}.',
    'social.deceive': 'אני מנסה לרמות את @{name}.',
    'social.seduce': 'אני מנסה לפתות את @{name}.',
    'social.insight': 'אני מתבונן היטב ב-@{name}, מחפש סימנים.',
    attack: 'אני תוקף את @{name}.',
    'string.spend': 'אני נשען על מה שעבר בינינו ומוציא חוט על @{name}.',
    'inspiration.spend': 'אני נשען על מה שהופך אותי לעצמי וקורא להשראה לקראת החילוף הבא.',
  },
  ar: {
    'travel.location': 'أتحرك إلى @{name} وأتلفت حولي: من هنا، ماذا يحدث، أين الخطر وأين المكسب.',
    'travel.scene': 'أدخل @{name} وأتلفت حولي: من هنا، ماذا يحدث، أين الخطر وأين المكسب.',
    'item.look': 'أتفحص @{name} بعناية.',
    'item.check': 'أدرس @{name} بعناية وأجرب النهج المتاح.',
    'social.persuade': 'أحاول إقناع @{name}.',
    'social.intimidate': 'أحاول إرهاب @{name}.',
    'social.deceive': 'أحاول خداع @{name}.',
    'social.seduce': 'أحاول إغواء @{name}.',
    'social.insight': 'أراقب @{name} بعناية، باحثا عن العلامات.',
    attack: 'أهاجم @{name}.',
    'string.spend': 'أضغط بما حدث بيننا وأنفق خيطا على @{name}.',
    'inspiration.spend': 'أستند إلى ما يجعلني أنا وأستدعي الإلهام للتبادل التالي.',
  },
  fa: {
    'travel.location': 'به سوی @{name} می‌روم و اطراف را نگاه می‌کنم: چه کسی اینجاست، چه می‌گذرد، خطر و سود کجاست.',
    'travel.scene': 'وارد @{name} می‌شوم و اطراف را نگاه می‌کنم: چه کسی اینجاست، چه می‌گذرد، خطر و سود کجاست.',
    'item.look': '@{name} را با دقت بررسی می‌کنم.',
    'item.check': '@{name} را با دقت می‌سنجم و روش موجود را امتحان می‌کنم.',
    'social.persuade': 'سعی می‌کنم @{name} را قانع کنم.',
    'social.intimidate': 'سعی می‌کنم @{name} را بترسانم.',
    'social.deceive': 'سعی می‌کنم @{name} را فریب بدهم.',
    'social.seduce': 'سعی می‌کنم @{name} را اغوا کنم.',
    'social.insight': '@{name} را دقیق زیر نظر می‌گیرم و دنبال نشانه‌ها می‌گردم.',
    attack: 'به @{name} حمله می‌کنم.',
    'string.spend': 'از چیزی که میان ما گذشته استفاده می‌کنم و یک رشته روی @{name} خرج می‌کنم.',
    'inspiration.spend': 'به چیزی که مرا خودم می‌کند تکیه می‌کنم و برای تبادل بعدی الهام می‌طلبم.',
  },
  ur: {
    'travel.location': 'میں @{name} کی طرف جاتا ہوں اور آس پاس دیکھتا ہوں: کون ہے، کیا ہو رہا ہے، خطرہ اور فائدہ کہاں ہے۔',
    'travel.scene': 'میں @{name} میں داخل ہوتا ہوں اور آس پاس دیکھتا ہوں: کون ہے، کیا ہو رہا ہے، خطرہ اور فائدہ کہاں ہے۔',
    'item.look': 'میں @{name} کو غور سے دیکھتا ہوں۔',
    'item.check': 'میں @{name} کا بغور جائزہ لیتا ہوں اور دستیاب طریقہ آزماتا ہوں۔',
    'social.persuade': 'میں @{name} کو قائل کرنے کی کوشش کرتا ہوں۔',
    'social.intimidate': 'میں @{name} کو ڈرانے کی کوشش کرتا ہوں۔',
    'social.deceive': 'میں @{name} کو دھوکا دینے کی کوشش کرتا ہوں۔',
    'social.seduce': 'میں @{name} کو لبھانے کی کوشش کرتا ہوں۔',
    'social.insight': 'میں @{name} کو غور سے دیکھتا ہوں، نشانیاں تلاش کرتے ہوئے۔',
    attack: 'میں @{name} پر حملہ کرتا ہوں۔',
    'string.spend': 'میں ہمارے بیچ گزرے لمحے کو استعمال کرتا ہوں اور @{name} پر ایک ڈور خرچ کرتا ہوں۔',
    'inspiration.spend': 'میں اپنی اصل طاقت پر بھروسا کرتا ہوں اور اگلے تبادلے کے لیے الہام پکارتا ہوں۔',
  },
  hi: {
    'travel.location': 'मैं @{name} की ओर जाता हूँ और चारों तरफ देखता हूँ: कौन है, क्या हो रहा है, जोखिम और लाभ कहाँ हैं।',
    'travel.scene': 'मैं @{name} में प्रवेश करता हूँ और चारों तरफ देखता हूँ: कौन है, क्या हो रहा है, जोखिम और लाभ कहाँ हैं।',
    'item.look': 'मैं @{name} को ध्यान से देखता हूँ।',
    'item.check': 'मैं @{name} की सावधानी से जाँच करता हूँ और उपलब्ध तरीका आजमाता हूँ।',
    'social.persuade': 'मैं @{name} को मनाने की कोशिश करता हूँ।',
    'social.intimidate': 'मैं @{name} को डराने की कोशिश करता हूँ।',
    'social.deceive': 'मैं @{name} को धोखा देने की कोशिश करता हूँ।',
    'social.seduce': 'मैं @{name} को रिझाने की कोशिश करता हूँ।',
    'social.insight': 'मैं @{name} को ध्यान से देखता हूँ, संकेत खोजते हुए।',
    attack: 'मैं @{name} पर हमला करता हूँ।',
    'string.spend': 'मैं हमारे बीच हुई बात का दबाव बनाता हूँ और @{name} पर एक स्ट्रिंग खर्च करता हूँ।',
    'inspiration.spend': 'मैं अपनी असली पहचान पर भरोसा करता हूँ और अगले आदान-प्रदान के लिए प्रेरणा बुलाता हूँ।',
  },
  mr: {
    'travel.location': 'मी @{name} कडे जातो आणि आजूबाजूला पाहतो: कोण आहे, काय घडते, धोका आणि फायदा कुठे आहे.',
    'travel.scene': 'मी @{name} मध्ये प्रवेश करतो आणि आजूबाजूला पाहतो: कोण आहे, काय घडते, धोका आणि फायदा कुठे आहे.',
    'item.look': 'मी @{name} नीट पाहतो.',
    'item.check': 'मी @{name} काळजीपूर्वक तपासतो आणि उपलब्ध मार्ग वापरून पाहतो.',
    'social.persuade': 'मी @{name} ला पटवण्याचा प्रयत्न करतो.',
    'social.intimidate': 'मी @{name} ला घाबरवण्याचा प्रयत्न करतो.',
    'social.deceive': 'मी @{name} ला फसवण्याचा प्रयत्न करतो.',
    'social.seduce': 'मी @{name} ला मोहात पाडण्याचा प्रयत्न करतो.',
    'social.insight': 'मी @{name} कडे बारकाईने पाहतो, चिन्हे शोधत.',
    attack: 'मी @{name} वर हल्ला करतो.',
    'string.spend': 'आपल्यात जे घडले त्याचा आधार घेत मी @{name} वर एक स्ट्रिंग खर्च करतो.',
    'inspiration.spend': 'मी माझ्या खऱ्या स्वरूपावर आधार घेत पुढच्या देवाणघेवाणीसाठी प्रेरणा बोलावतो.',
  },
  ne: {
    'travel.location': 'म @{name} तिर जान्छु र वरिपरि हेर्छु: को छ, के भइरहेको छ, जोखिम र फाइदा कहाँ छन्।',
    'travel.scene': 'म @{name} भित्र पस्छु र वरिपरि हेर्छु: को छ, के भइरहेको छ, जोखिम र फाइदा कहाँ छन्।',
    'item.look': 'म @{name} लाई ध्यान दिएर हेर्छु।',
    'item.check': 'म @{name} लाई ध्यान दिएर जाँच्छु र उपलब्ध तरिका प्रयास गर्छु।',
    'social.persuade': 'म @{name} लाई मनाउने प्रयास गर्छु।',
    'social.intimidate': 'म @{name} लाई तर्साउने प्रयास गर्छु।',
    'social.deceive': 'म @{name} लाई छल गर्ने प्रयास गर्छु।',
    'social.seduce': 'म @{name} लाई मोहमा पार्ने प्रयास गर्छु।',
    'social.insight': 'म @{name} लाई ध्यान दिएर हेर्छु, संकेत खोज्दै।',
    attack: 'म @{name} माथि आक्रमण गर्छु।',
    'string.spend': 'हामीबीच भएको कुरामा टेक्दै म @{name} माथि एउटा स्ट्रिङ खर्च गर्छु।',
    'inspiration.spend': 'म आफूलाई बनाउने कुरामा भर पर्छु र अर्को आदानप्रदानका लागि प्रेरणा बोलाउँछु।',
  },
  bn: {
    'travel.location': 'আমি @{name}-এর দিকে যাই এবং চারপাশ দেখি: কে আছে, কী ঘটছে, ঝুঁকি আর লাভ কোথায়।',
    'travel.scene': 'আমি @{name}-এ ঢুকি এবং চারপাশ দেখি: কে আছে, কী ঘটছে, ঝুঁকি আর লাভ কোথায়।',
    'item.look': 'আমি @{name} মন দিয়ে দেখি।',
    'item.check': 'আমি @{name} মন দিয়ে পরীক্ষা করি এবং উপলভ্য পদ্ধতি চেষ্টা করি।',
    'social.persuade': 'আমি @{name} কে রাজি করানোর চেষ্টা করি।',
    'social.intimidate': 'আমি @{name} কে ভয় দেখানোর চেষ্টা করি।',
    'social.deceive': 'আমি @{name} কে প্রতারণা করার চেষ্টা করি।',
    'social.seduce': 'আমি @{name} কে প্রলুব্ধ করার চেষ্টা করি।',
    'social.insight': 'আমি @{name} কে মন দিয়ে দেখি, লক্ষণ খুঁজি।',
    attack: 'আমি @{name} কে আক্রমণ করি।',
    'string.spend': 'আমাদের মধ্যে যা ঘটেছে তা কাজে লাগিয়ে @{name}-এর ওপর একটি স্ট্রিং খরচ করি।',
    'inspiration.spend': 'আমি যা আমাকে আমি করে, তার ওপর ভর করে পরের বিনিময়ের জন্য অনুপ্রেরণা ডাকি।',
  },
  th: {
    'travel.location': 'ฉันไปที่ @{name} แล้วมองไปรอบๆ: ใครอยู่ที่นี่ เกิดอะไรขึ้น ความเสี่ยงและผลตอบแทนอยู่ตรงไหน',
    'travel.scene': 'ฉันเข้าไปใน @{name} แล้วมองไปรอบๆ: ใครอยู่ที่นี่ เกิดอะไรขึ้น ความเสี่ยงและผลตอบแทนอยู่ตรงไหน',
    'item.look': 'ฉันตรวจดู @{name} อย่างละเอียด',
    'item.check': 'ฉันศึกษาดู @{name} อย่างรอบคอบแล้วลองวิธีที่มีอยู่',
    'social.persuade': 'ฉันพยายามโน้มน้าว @{name}',
    'social.intimidate': 'ฉันพยายามข่มขู่ @{name}',
    'social.deceive': 'ฉันพยายามหลอก @{name}',
    'social.seduce': 'ฉันพยายามยั่วยวน @{name}',
    'social.insight': 'ฉันจับตาดู @{name} อย่างละเอียดเพื่อหาเบาะแส',
    attack: 'ฉันโจมตี @{name}',
    'string.spend': 'ฉันใช้สิ่งที่เคยเกิดขึ้นระหว่างเราและใช้หนึ่งสายสัมพันธ์กับ @{name}',
    'inspiration.spend': 'ฉันดึงสิ่งที่ทำให้ฉันเป็นตัวเองขึ้นมา และเรียกแรงบันดาลใจสำหรับการแลกเปลี่ยนครั้งต่อไป',
  },
  el: {
    'travel.location': 'Πηγαίνω στο @{name} και κοιτάζω γύρω: ποιος είναι εδώ, τι συμβαίνει, πού υπάρχει ρίσκο και κέρδος.',
    'travel.scene': 'Μπαίνω στο @{name} και κοιτάζω γύρω: ποιος είναι εδώ, τι συμβαίνει, πού υπάρχει ρίσκο και κέρδος.',
    'item.look': 'Εξετάζω προσεκτικά το @{name}.',
    'item.check': 'Μελετώ προσεκτικά το @{name} και δοκιμάζω τη διαθέσιμη προσέγγιση.',
    'social.persuade': 'Προσπαθώ να πείσω τον/την @{name}.',
    'social.intimidate': 'Προσπαθώ να εκφοβίσω τον/την @{name}.',
    'social.deceive': 'Προσπαθώ να εξαπατήσω τον/την @{name}.',
    'social.seduce': 'Προσπαθώ να σαγηνεύσω τον/την @{name}.',
    'social.insight': 'Παρατηρώ προσεκτικά τον/την @{name}, ψάχνοντας σημάδια.',
    attack: 'Επιτίθεμαι στον/στην @{name}.',
    'string.spend': 'Πατάω πάνω σε ό,τι συνέβη μεταξύ μας και ξοδεύω ένα Νήμα στον/στην @{name}.',
    'inspiration.spend': 'Στηρίζομαι σε αυτό που με κάνει εμένα και καλώ Έμπνευση για την επόμενη ανταλλαγή.',
  },
  hy: {
    'travel.location': 'Գնում եմ դեպի @{name} և շուրջս եմ նայում՝ ով կա, ինչ է կատարվում, որտեղ է ռիսկը և շահը։',
    'travel.scene': 'Մտնում եմ @{name} և շուրջս եմ նայում՝ ով կա, ինչ է կատարվում, որտեղ է ռիսկը և շահը։',
    'item.look': 'Ուշադիր զննում եմ @{name}։',
    'item.check': 'Ուշադիր ուսումնասիրում եմ @{name} և փորձում հասանելի մոտեցումը։',
    'social.persuade': 'Փորձում եմ համոզել @{name}-ին։',
    'social.intimidate': 'Փորձում եմ վախեցնել @{name}-ին։',
    'social.deceive': 'Փորձում եմ խաբել @{name}-ին։',
    'social.seduce': 'Փորձում եմ գայթակղել @{name}-ին։',
    'social.insight': 'Ուշադիր հետևում եմ @{name}-ին՝ նշաններ փնտրելով։',
    attack: 'Հարձակվում եմ @{name}-ի վրա։',
    'string.spend': 'Օգտվում եմ մեր միջև եղածից և մի Լար եմ ծախսում @{name}-ի վրա։',
    'inspiration.spend': 'Հենվում եմ այն բանի վրա, ինչ ինձ ինձ է դարձնում, և Ոգեշնչում եմ կանչում հաջորդ փոխանակման համար։',
  },
  ka: {
    'travel.location': 'მივდივარ @{name}-ისკენ და ირგვლივ ვიხედები: ვინ არის აქ, რა ხდება, სად არის რისკი და სარგებელი.',
    'travel.scene': 'შევდივარ @{name}-ში და ირგვლივ ვიხედები: ვინ არის აქ, რა ხდება, სად არის რისკი და სარგებელი.',
    'item.look': 'ყურადღებით ვათვალიერებ @{name}-ს.',
    'item.check': 'ყურადღებით ვსწავლობ @{name}-ს და ვცდი ხელმისაწვდომ გზას.',
    'social.persuade': 'ვცდილობ დავარწმუნო @{name}.',
    'social.intimidate': 'ვცდილობ შევაშინო @{name}.',
    'social.deceive': 'ვცდილობ მოვატყუო @{name}.',
    'social.seduce': 'ვცდილობ მოვხიბლო @{name}.',
    'social.insight': 'ყურადღებით ვაკვირდები @{name}-ს, ნიშნებს ვეძებ.',
    attack: '@{name}-ს ვუტევ.',
    'string.spend': 'ვიყენებ იმას, რაც ჩვენს შორის მოხდა, და ერთ სიმს ვხარჯავ @{name}-ზე.',
    'inspiration.spend': 'ვეყრდნობი იმას, რაც მე მქმნის, და შემდეგი გაცვლისთვის შთაგონებას ვუხმობ.',
  },
  ko: {
    'travel.location': '@{name}(으)로 가서 둘러본다: 누가 있는지, 무슨 일이 벌어지는지, 위험과 이득이 어디 있는지.',
    'travel.scene': '@{name}에 들어가 둘러본다: 누가 있는지, 무슨 일이 벌어지는지, 위험과 이득이 어디 있는지.',
    'item.look': '@{name}을 자세히 살펴본다.',
    'item.check': '@{name}을 신중히 조사하고 가능한 접근을 시도한다.',
    'social.persuade': '@{name}을 설득하려 한다.',
    'social.intimidate': '@{name}을 위협하려 한다.',
    'social.deceive': '@{name}을 속이려 한다.',
    'social.seduce': '@{name}을 유혹하려 한다.',
    'social.insight': '@{name}을 유심히 관찰하며 단서를 찾는다.',
    attack: '@{name}을 공격한다.',
    'string.spend': '우리 사이에 있었던 일을 이용해 @{name}에게 스트링 하나를 쓴다.',
    'inspiration.spend': '나를 나답게 만드는 것에 기대어 다음 교환에 영감을 부른다.',
  },
  ja: {
    'travel.location': '@{name}へ向かい、周囲を見回す。誰がいて、何が起き、どこに危険と見返りがあるかを探る。',
    'travel.scene': '@{name}に入り、周囲を見回す。誰がいて、何が起き、どこに危険と見返りがあるかを探る。',
    'item.look': '@{name}を注意深く調べる。',
    'item.check': '@{name}を慎重に調べ、使える手段を試す。',
    'social.persuade': '@{name}を説得しようとする。',
    'social.intimidate': '@{name}を脅そうとする。',
    'social.deceive': '@{name}を欺こうとする。',
    'social.seduce': '@{name}を誘惑しようとする。',
    'social.insight': '@{name}を注意深く観察し、兆しを探る。',
    attack: '@{name}を攻撃する。',
    'string.spend': '二人の間にあったことを利用し、@{name}にストリングを1つ使う。',
    'inspiration.spend': '自分を自分たらしめるものに頼り、次のやり取りにインスピレーションを呼び込む。',
  },
  zh: {
    'travel.location': '我前往 @{name}，环顾四周：这里有谁，发生了什么，风险和收益在哪里。',
    'travel.scene': '我进入 @{name}，环顾四周：这里有谁，发生了什么，风险和收益在哪里。',
    'item.look': '我仔细查看 @{name}。',
    'item.check': '我仔细研究 @{name}，尝试可用的方法。',
    'social.persuade': '我试图说服 @{name}。',
    'social.intimidate': '我试图威吓 @{name}。',
    'social.deceive': '我试图欺骗 @{name}。',
    'social.seduce': '我试图诱惑 @{name}。',
    'social.insight': '我仔细观察 @{name}，寻找破绽。',
    attack: '我攻击 @{name}。',
    'string.spend': '我利用我们之间发生过的事，在 @{name} 身上花费一条牵绊。',
    'inspiration.spend': '我依靠真正定义自己的东西，为下一次交锋唤起灵感。',
  },
};

const TALK_TEXT: Record<string, string> = {
  en: 'I speak with @{name}.',
  ru: 'Говорю с @{name}.',
  uk: 'Говорю з @{name}.',
  bg: 'Говоря с @{name}.',
  sr: 'Разговарам са @{name}.',
  es: 'Hablo con @{name}.',
  fr: 'Je parle avec @{name}.',
  de: 'Ich spreche mit @{name}.',
  it: 'Parlo con @{name}.',
  pt: 'Falo com @{name}.',
  ro: 'Vorbesc cu @{name}.',
  he: 'אני מדבר עם @{name}.',
  ar: 'أتحدث مع @{name}.',
  fa: 'با @{name} صحبت می‌کنم.',
  ur: 'میں @{name} سے بات کرتا ہوں۔',
  hi: 'मैं @{name} से बात करता हूँ।',
  mr: 'मी @{name} शी बोलतो.',
  ne: 'म @{name} सँग कुरा गर्छु।',
  bn: 'আমি @{name} এর সঙ্গে কথা বলি।',
  th: 'ฉันคุยกับ @{name}',
  el: 'Μιλάω με @{name}.',
  hy: 'Խոսում եմ @{name}-ի հետ։',
  ka: '@{name}-ს ველაპარაკები.',
  ko: '@{name}와 이야기한다.',
  ja: '@{name}と話す。',
  zh: '我与 @{name} 交谈。',
};

for (const language of SUPPORTED_LANGUAGES) {
  if (!ACTION_TEXT[language.code]) {
    throw new Error(`missing action text catalog for ${language.code}`);
  }
  if (!TALK_TEXT[language.code]) {
    throw new Error(`missing talk text catalog for ${language.code}`);
  }
}

function interpolate(template: string, vars: ActionVars): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    String(vars[key] ?? ''),
  );
}

export function localizedActionText(
  key: ActionTextKey,
  vars: ActionVars = {},
  language?: string | null,
): string {
  const lang = normalizeSupportedLanguageCode(language) ?? 'en';
  const pack = ACTION_TEXT[lang];
  if (!pack) {
    throw new Error(`missing action text catalog for ${lang}`);
  }
  const template = pack[key];
  return interpolate(template, vars);
}

export function localizedTravelMessage(
  target: {name: string; type?: string | null},
  language?: string | null,
): string {
  const key = target.type === 'scene' ? 'travel.scene' : 'travel.location';
  return localizedActionText(key, {name: target.name}, language);
}

export function localizedItemLookMessage(
  target: {name: string},
  language?: string | null,
): string {
  return localizedActionText('item.look', {name: target.name}, language);
}

export function localizedTalkMessage(
  target: {name: string},
  language?: string | null,
): string {
  const lang = normalizeSupportedLanguageCode(language) ?? 'en';
  // `TALK_TEXT['en']` is the catalog the SUPPORTED_LANGUAGES loop above
  // throws for if missing, so the English fallback is always present.
  const template = TALK_TEXT[lang] ?? TALK_TEXT['en']!;
  return interpolate(template, {name: target.name});
}

export function localizedAffordanceMessage(
  action: {
    id?: string;
    kind?: string;
    entityName?: string | null;
    fallbackLabel?: string;
    messageKey?: string | null;
    messageVars?: ActionVars | null;
  },
  language?: string | null,
): string {
  const name =
    action.entityName ??
    (typeof action.messageVars?.name === 'string' ? action.messageVars.name : '');
  const kind = action.kind ?? '';
  if (action.messageKey === 'quest.choice') {
    return String(action.messageVars?.choice ?? action.fallbackLabel ?? '').trim();
  }
  if (
    action.messageKey &&
    Object.prototype.hasOwnProperty.call(EN, action.messageKey)
  ) {
    return localizedActionText(
      action.messageKey as ActionTextKey,
      {...(action.messageVars ?? {}), name},
      language,
    );
  }
  if (kind === 'travel' || kind === 'location') {
    return localizedTravelMessage({name, type: 'location'}, language);
  }
  if (kind === 'scene') {
    return localizedTravelMessage({name, type: 'scene'}, language);
  }
  if (kind === 'item-check') {
    return localizedActionText('item.check', {name}, language);
  }
  if (kind.startsWith('social-')) {
    const socialKind = kind.slice('social-'.length);
    const key = `social.${socialKind}` as ActionTextKey;
    if (EN[key]) return localizedActionText(key, {name}, language);
  }
  if (kind === 'attack') {
    return localizedActionText('attack', {name}, language);
  }
  if (kind === 'string-spend') {
    return localizedActionText('string.spend', {name}, language);
  }
  if (kind === 'inspiration-spend') {
    return localizedActionText('inspiration.spend', {}, language);
  }
  return name ? `@${name}` : '';
}
