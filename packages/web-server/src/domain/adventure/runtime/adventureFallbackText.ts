/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ScriptTag} from '../../../agents/scriptUtil.js';
import type {AdventureKind} from './adventureTables.js';

export interface AdventureFallbackTextPack {
  noticeStageTitle: string;
  followStageTitle: string;
  timingClueText: string;
  acceptCondition: string;
  goalText: string;
  title(kind: AdventureKind | string, anchorName: string): string;
  genericHook(anchorName: string): string;
  hiddenLocationHook(anchorName: string, locationName: string): string;
  hiddenLocationName(queueId: number, kind: AdventureKind | string): string;
  itemName(queueId: number): string;
  questCauseClaim(title: string): string;
  entityCauseClaim(anchorName: string): string;
  hiddenLocationWhyHere(locationName: string): string;
  itemProvenance(anchorName: string): string;
  secretText(anchorName: string): string;
  npcClueText(anchorName: string): string;
  locationClueText(anchorName: string): string;
  bridgeSummary(title: string): string;
  bridgeGoalText(title: string): string;
}

export interface AdventureFallbackTextSource {
  queue: {
    id: number;
    contextSnapshot: Record<string, unknown>;
  };
  recentNarrative: string;
}

export type AdventureFallbackTextPackMap = Record<string, AdventureFallbackTextPack>;

export const EN_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'Notice the lead',
  followStageTitle: 'Follow the lead',
  timingClueText: 'The timing of the moment makes the lead noticeable now.',
  acceptCondition: 'Accept the lead and investigate it in the current scene.',
  goalText: 'Investigate the lead and decide whether it matters.',
  title(kind, anchorName) {
    switch (kind) {
      case 'social_hook':
        return `A Word Near ${anchorName}`;
      case 'exploration_clue':
        return `A Clue Near ${anchorName}`;
      case 'hidden_location':
        return `An Unmarked Way Near ${anchorName}`;
      case 'item_discovery':
        return `A Trace Near ${anchorName}`;
      case 'hazard':
        return `A Risk Near ${anchorName}`;
      case 'ambush':
        return `A Bad Sign Near ${anchorName}`;
      case 'quest_complication':
        return `A Complication Near ${anchorName}`;
      case 'downtime_rumor':
        return `A Rumor Near ${anchorName}`;
      default:
        return `A Lead Near ${anchorName}`;
    }
  },
  genericHook: anchorName =>
    `A quiet lead near @${anchorName} opens a small adventure thread, but it needs a deliberate choice before anything becomes canon.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `A quiet lead near @${anchorName} points toward @${locationName}, but it needs investigation before it becomes certain.`,
  hiddenLocationName: (queueId, kind) =>
    `Unmarked ${kind === 'hidden_location' ? 'Way' : 'Lead'} ${queueId}`,
  itemName: queueId => `Unclaimed Trace ${queueId}`,
  questCauseClaim: title =>
    `The open quest "${title}" can absorb a safe complication.`,
  entityCauseClaim: anchorName =>
    `${anchorName} provides enough in-world context for a small adventure lead.`,
  hiddenLocationWhyHere: locationName =>
    `A subtle route branches from ${locationName}.`,
  itemProvenance: anchorName =>
    `The trace belongs to ${anchorName} or the current scene, not to the player yet.`,
  secretText: anchorName => `A small lead is present near ${anchorName}.`,
  npcClueText: anchorName =>
    `${anchorName} can point toward the lead without granting a reward.`,
  locationClueText: anchorName =>
    `The surroundings near ${anchorName} show a physical sign.`,
  bridgeSummary: title => `Fallback complication attached to ${title}.`,
  bridgeGoalText: title => `Fold this lead into ${title}.`,
};

const RU_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'Заметить зацепку',
  followStageTitle: 'Проследить зацепку',
  timingClueText: 'Именно сейчас эта зацепка становится заметной.',
  acceptCondition: 'Принять зацепку и проверить ее в текущей сцене.',
  goalText: 'Исследовать зацепку и решить, имеет ли она значение.',
  title(kind, anchorName) {
    switch (kind) {
      case 'social_hook':
        return `Слово рядом с ${anchorName}`;
      case 'exploration_clue':
        return `Зацепка рядом с ${anchorName}`;
      case 'hidden_location':
        return `Незаметный путь рядом с ${anchorName}`;
      case 'item_discovery':
        return `След рядом с ${anchorName}`;
      case 'hazard':
        return `Риск рядом с ${anchorName}`;
      case 'ambush':
        return `Дурной знак рядом с ${anchorName}`;
      case 'quest_complication':
        return `Осложнение рядом с ${anchorName}`;
      case 'downtime_rumor':
        return `Слух рядом с ${anchorName}`;
      default:
        return `Наводка рядом с ${anchorName}`;
    }
  },
  genericHook: anchorName =>
    `Тихая зацепка рядом с @${anchorName} открывает небольшую приключенческую нить, но нужен осознанный выбор, прежде чем что-то станет каноном.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `Тихая зацепка рядом с @${anchorName} указывает на @${locationName}, но нужна проверка, прежде чем это станет достоверным.`,
  hiddenLocationName: queueId => `Незаметный путь ${queueId}`,
  itemName: queueId => `Найденный след ${queueId}`,
  questCauseClaim: title =>
    `Активный квест "${title}" может принять небольшое осложнение.`,
  entityCauseClaim: anchorName =>
    `${anchorName} дает достаточно внутриигровой опоры для небольшой зацепки.`,
  hiddenLocationWhyHere: locationName =>
    `От ${locationName} отходит едва заметный путь.`,
  itemProvenance: anchorName =>
    `Этот след связан с ${anchorName} или текущей сценой и еще не принадлежит игроку.`,
  secretText: anchorName => `Небольшая зацепка заметна рядом с ${anchorName}.`,
  npcClueText: anchorName =>
    `${anchorName} может указать на зацепку без немедленной награды.`,
  locationClueText: anchorName =>
    `Окружение рядом с ${anchorName} показывает физический признак.`,
  bridgeSummary: title => `Резервное осложнение привязано к квесту "${title}".`,
  bridgeGoalText: title => `Вплести эту зацепку в квест "${title}".`,
};

const UK_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'Помітити зачіпку',
  followStageTitle: 'Простежити зачіпку',
  timingClueText: 'Саме зараз ця зачіпка стає помітною.',
  acceptCondition: 'Прийняти зачіпку й перевірити її в поточній сцені.',
  goalText: 'Дослідити зачіпку й вирішити, чи має вона значення.',
  title: (kind, anchorName) => `${ukrainianKindTitle(kind)} поруч із ${anchorName}`,
  genericHook: anchorName =>
    `Тиха зачіпка поруч із @${anchorName} відкриває невелику пригоду, але потрібен свідомий вибір, перш ніж це стане каноном.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `Тиха зачіпка поруч із @${anchorName} вказує на @${locationName}, але потрібна перевірка, перш ніж це стане певним.`,
  hiddenLocationName: queueId => `Непозначений шлях ${queueId}`,
  itemName: queueId => `Неприсвоєний слід ${queueId}`,
  questCauseClaim: title =>
    `Активний квест "${title}" може прийняти безпечне ускладнення.`,
  entityCauseClaim: anchorName =>
    `${anchorName} дає достатню внутрішньоігрову опору для невеликої зачіпки.`,
  hiddenLocationWhyHere: locationName =>
    `Від ${locationName} відгалужується ледь помітний шлях.`,
  itemProvenance: anchorName =>
    `Цей слід пов'язаний із ${anchorName} або поточною сценою і ще не належить гравцю.`,
  secretText: anchorName => `Невелика зачіпка помітна поруч із ${anchorName}.`,
  npcClueText: anchorName =>
    `${anchorName} може вказати на зачіпку без негайної винагороди.`,
  locationClueText: anchorName =>
    `Оточення поруч із ${anchorName} показує фізичну ознаку.`,
  bridgeSummary: title => `Резервне ускладнення прив'язане до квесту "${title}".`,
  bridgeGoalText: title => `Вплести цю зачіпку в квест "${title}".`,
};

const BG_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'Забелязване на следата',
  followStageTitle: 'Проследяване на следата',
  timingClueText: 'Точно сега тази следа става забележима.',
  acceptCondition: 'Приеми следата и я провери в текущата сцена.',
  goalText: 'Проучи следата и реши дали има значение.',
  title: (kind, anchorName) => `${bulgarianKindTitle(kind)} край ${anchorName}`,
  genericHook: anchorName =>
    `Тиха следа край @${anchorName} отваря малка приключенска нишка, но е нужен осъзнат избор, преди да стане канон.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `Тиха следа край @${anchorName} сочи към @${locationName}, но трябва проверка, преди да стане сигурно.`,
  hiddenLocationName: queueId => `Немаркиран път ${queueId}`,
  itemName: queueId => `Непотърсена следа ${queueId}`,
  questCauseClaim: title =>
    `Активният куест "${title}" може да поеме безопасно усложнение.`,
  entityCauseClaim: anchorName =>
    `${anchorName} дава достатъчна вътрешносветова опора за малка следа.`,
  hiddenLocationWhyHere: locationName =>
    `От ${locationName} се отделя едва забележим път.`,
  itemProvenance: anchorName =>
    `Следата е свързана с ${anchorName} или текущата сцена и още не принадлежи на играча.`,
  secretText: anchorName => `Малка следа е видима край ${anchorName}.`,
  npcClueText: anchorName =>
    `${anchorName} може да посочи следата, без да дава награда.`,
  locationClueText: anchorName =>
    `Околността край ${anchorName} показва физически знак.`,
  bridgeSummary: title => `Резервно усложнение е свързано с куеста "${title}".`,
  bridgeGoalText: title => `Вплети тази следа в куеста "${title}".`,
};

const SR_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'Приметити траг',
  followStageTitle: 'Пратити траг',
  timingClueText: 'Баш сада овај траг постаје приметан.',
  acceptCondition: 'Прихвати траг и провери га у тренутној сцени.',
  goalText: 'Истражи траг и одлучи да ли има значаја.',
  title: (kind, anchorName) => `${serbianKindTitle(kind)} код ${anchorName}`,
  genericHook: anchorName =>
    `Тихи траг код @${anchorName} отвара малу авантуристичку нит, али потребан је свестан избор пре него што постане канон.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `Тихи траг код @${anchorName} упућује на @${locationName}, али треба провера пре него што постане извесно.`,
  hiddenLocationName: queueId => `Необележен пут ${queueId}`,
  itemName: queueId => `Непреузет траг ${queueId}`,
  questCauseClaim: title =>
    `Активни квест "${title}" може да прими безбедну компликацију.`,
  entityCauseClaim: anchorName =>
    `${anchorName} даје довољно унутарсветског ослонца за мали траг.`,
  hiddenLocationWhyHere: locationName =>
    `Од ${locationName} се одваја једва приметан пут.`,
  itemProvenance: anchorName =>
    `Овај траг је повезан са ${anchorName} или тренутном сценом и још не припада играчу.`,
  secretText: anchorName => `Мали траг је приметан код ${anchorName}.`,
  npcClueText: anchorName =>
    `${anchorName} може да укаже на траг без непосредне награде.`,
  locationClueText: anchorName =>
    `Окружење код ${anchorName} показује физички знак.`,
  bridgeSummary: title => `Резервна компликација је повезана са квестом "${title}".`,
  bridgeGoalText: title => `Уплети овај траг у квест "${title}".`,
};

const ES_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'Advertir la pista',
  followStageTitle: 'Seguir la pista',
  timingClueText: 'El momento hace que la pista sea visible ahora.',
  acceptCondition: 'Aceptar la pista e investigarla en la escena actual.',
  goalText: 'Investigar la pista y decidir si importa.',
  title: (kind, anchorName) => `${spanishKindTitle(kind)} cerca de ${anchorName}`,
  genericHook: anchorName =>
    `Una pista discreta cerca de @${anchorName} abre un pequeño hilo de aventura, pero necesita una elección deliberada antes de volverse canon.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `Una pista discreta cerca de @${anchorName} apunta hacia @${locationName}, pero requiere investigación antes de volverse cierta.`,
  hiddenLocationName: queueId => `Camino discreto ${queueId}`,
  itemName: queueId => `Rastro sin reclamar ${queueId}`,
  questCauseClaim: title =>
    `La misión activa "${title}" puede absorber una complicación segura.`,
  entityCauseClaim: anchorName =>
    `${anchorName} ofrece suficiente apoyo diegético para una pequeña pista.`,
  hiddenLocationWhyHere: locationName =>
    `Una ruta sutil se ramifica desde ${locationName}.`,
  itemProvenance: anchorName =>
    `El rastro pertenece a ${anchorName} o a la escena actual, no al jugador todavía.`,
  secretText: anchorName => `Hay una pequeña pista cerca de ${anchorName}.`,
  npcClueText: anchorName =>
    `${anchorName} puede señalar la pista sin entregar una recompensa.`,
  locationClueText: anchorName =>
    `El entorno cerca de ${anchorName} muestra una señal física.`,
  bridgeSummary: title => `Complicación de reserva vinculada a "${title}".`,
  bridgeGoalText: title => `Integrar esta pista en "${title}".`,
};

const FR_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'Remarquer la piste',
  followStageTitle: 'Suivre la piste',
  timingClueText: 'Le moment rend cette piste visible maintenant.',
  acceptCondition: 'Accepter la piste et l examiner dans la scène actuelle.',
  goalText: 'Examiner la piste et décider si elle compte.',
  title: (kind, anchorName) => `${frenchKindTitle(kind)} près de ${anchorName}`,
  genericHook: anchorName =>
    `Une piste discrète près de @${anchorName} ouvre un petit fil d aventure, mais il faut un choix délibéré avant que cela devienne canon.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `Une piste discrète près de @${anchorName} mène vers @${locationName}, mais elle doit être vérifiée avant de devenir certaine.`,
  hiddenLocationName: queueId => `Passage discret ${queueId}`,
  itemName: queueId => `Trace non réclamée ${queueId}`,
  questCauseClaim: title =>
    `La quête active "${title}" peut absorber une complication sûre.`,
  entityCauseClaim: anchorName =>
    `${anchorName} donne assez d appui dans le monde pour une petite piste.`,
  hiddenLocationWhyHere: locationName =>
    `Un itinéraire subtil part de ${locationName}.`,
  itemProvenance: anchorName =>
    `Cette trace appartient à ${anchorName} ou à la scène actuelle, pas encore au joueur.`,
  secretText: anchorName => `Une petite piste existe près de ${anchorName}.`,
  npcClueText: anchorName =>
    `${anchorName} peut indiquer la piste sans donner de récompense.`,
  locationClueText: anchorName =>
    `Les alentours de ${anchorName} montrent un signe physique.`,
  bridgeSummary: title => `Complication de secours liée à "${title}".`,
  bridgeGoalText: title => `Intégrer cette piste à "${title}".`,
};

const DE_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'Den Hinweis bemerken',
  followStageTitle: 'Dem Hinweis folgen',
  timingClueText: 'Der Moment macht den Hinweis jetzt sichtbar.',
  acceptCondition: 'Den Hinweis annehmen und in der aktuellen Szene untersuchen.',
  goalText: 'Den Hinweis untersuchen und entscheiden, ob er wichtig ist.',
  title: (kind, anchorName) => `${germanKindTitle(kind)} bei ${anchorName}`,
  genericHook: anchorName =>
    `Ein leiser Hinweis bei @${anchorName} öffnet einen kleinen Abenteuerfaden, braucht aber eine bewusste Entscheidung, bevor er Kanon wird.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `Ein leiser Hinweis bei @${anchorName} deutet auf @${locationName}, muss aber untersucht werden, bevor er sicher ist.`,
  hiddenLocationName: queueId => `Unmarkierter Weg ${queueId}`,
  itemName: queueId => `Unbeanspruchte Spur ${queueId}`,
  questCauseClaim: title =>
    `Die aktive Quest "${title}" kann eine sichere Komplikation aufnehmen.`,
  entityCauseClaim: anchorName =>
    `${anchorName} liefert genug Spielwelt-Kontext für einen kleinen Hinweis.`,
  hiddenLocationWhyHere: locationName =>
    `Ein unauffälliger Weg zweigt von ${locationName} ab.`,
  itemProvenance: anchorName =>
    `Die Spur gehört zu ${anchorName} oder zur aktuellen Szene, noch nicht dem Spieler.`,
  secretText: anchorName => `Ein kleiner Hinweis liegt bei ${anchorName}.`,
  npcClueText: anchorName =>
    `${anchorName} kann auf den Hinweis zeigen, ohne eine Belohnung zu gewähren.`,
  locationClueText: anchorName =>
    `Die Umgebung bei ${anchorName} zeigt ein physisches Zeichen.`,
  bridgeSummary: title => `Fallback-Komplikation an "${title}" angehängt.`,
  bridgeGoalText: title => `Diesen Hinweis in "${title}" einfügen.`,
};

const IT_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'Notare l indizio',
  followStageTitle: 'Seguire l indizio',
  timingClueText: 'Il momento rende visibile l indizio proprio ora.',
  acceptCondition: 'Accettare l indizio e indagarlo nella scena attuale.',
  goalText: 'Indagare l indizio e decidere se conta.',
  title: (kind, anchorName) => `${italianKindTitle(kind)} vicino a ${anchorName}`,
  genericHook: anchorName =>
    `Un indizio discreto vicino a @${anchorName} apre un piccolo filo d avventura, ma serve una scelta deliberata prima che diventi canone.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `Un indizio discreto vicino a @${anchorName} punta verso @${locationName}, ma va verificato prima che sia certo.`,
  hiddenLocationName: queueId => `Passaggio discreto ${queueId}`,
  itemName: queueId => `Traccia non reclamata ${queueId}`,
  questCauseClaim: title =>
    `La missione attiva "${title}" può assorbire una complicazione sicura.`,
  entityCauseClaim: anchorName =>
    `${anchorName} offre abbastanza contesto diegetico per un piccolo indizio.`,
  hiddenLocationWhyHere: locationName =>
    `Una via sottile si dirama da ${locationName}.`,
  itemProvenance: anchorName =>
    `La traccia appartiene a ${anchorName} o alla scena attuale, non ancora al giocatore.`,
  secretText: anchorName => `Un piccolo indizio è presente vicino a ${anchorName}.`,
  npcClueText: anchorName =>
    `${anchorName} può indicare l indizio senza concedere una ricompensa.`,
  locationClueText: anchorName =>
    `L ambiente vicino a ${anchorName} mostra un segno fisico.`,
  bridgeSummary: title => `Complicazione di riserva collegata a "${title}".`,
  bridgeGoalText: title => `Inserire questo indizio in "${title}".`,
};

const PT_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'Notar a pista',
  followStageTitle: 'Seguir a pista',
  timingClueText: 'O momento torna a pista perceptível agora.',
  acceptCondition: 'Aceitar a pista e investigá-la na cena atual.',
  goalText: 'Investigar a pista e decidir se ela importa.',
  title: (kind, anchorName) => `${portugueseKindTitle(kind)} perto de ${anchorName}`,
  genericHook: anchorName =>
    `Uma pista discreta perto de @${anchorName} abre um pequeno fio de aventura, mas precisa de uma escolha deliberada antes de virar cânone.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `Uma pista discreta perto de @${anchorName} aponta para @${locationName}, mas precisa ser investigada antes de se tornar certa.`,
  hiddenLocationName: queueId => `Caminho discreto ${queueId}`,
  itemName: queueId => `Rastro não reclamado ${queueId}`,
  questCauseClaim: title =>
    `A missão ativa "${title}" pode absorver uma complicação segura.`,
  entityCauseClaim: anchorName =>
    `${anchorName} oferece apoio diegético suficiente para uma pequena pista.`,
  hiddenLocationWhyHere: locationName =>
    `Uma rota sutil se ramifica a partir de ${locationName}.`,
  itemProvenance: anchorName =>
    `O rastro pertence a ${anchorName} ou à cena atual, ainda não ao jogador.`,
  secretText: anchorName => `Uma pequena pista está perto de ${anchorName}.`,
  npcClueText: anchorName =>
    `${anchorName} pode apontar a pista sem conceder recompensa.`,
  locationClueText: anchorName =>
    `O entorno perto de ${anchorName} mostra um sinal físico.`,
  bridgeSummary: title => `Complicação de reserva ligada a "${title}".`,
  bridgeGoalText: title => `Integrar esta pista a "${title}".`,
};

const RO_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'Observă indiciul',
  followStageTitle: 'Urmărește indiciul',
  timingClueText: 'Momentul face ca indiciul să fie vizibil acum.',
  acceptCondition: 'Acceptă indiciul și investighează-l în scena curentă.',
  goalText: 'Investighează indiciul și decide dacă are importanță.',
  title: (kind, anchorName) => `${romanianKindTitle(kind)} lângă ${anchorName}`,
  genericHook: anchorName =>
    `Un indiciu discret lângă @${anchorName} deschide un mic fir de aventură, dar are nevoie de o alegere deliberată înainte să devină canon.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `Un indiciu discret lângă @${anchorName} indică spre @${locationName}, dar trebuie investigat înainte să devină sigur.`,
  hiddenLocationName: queueId => `Drum nemarcat ${queueId}`,
  itemName: queueId => `Urmă nerevendicată ${queueId}`,
  questCauseClaim: title =>
    `Questul activ "${title}" poate primi o complicație sigură.`,
  entityCauseClaim: anchorName =>
    `${anchorName} oferă suficient sprijin din lumea jocului pentru un indiciu mic.`,
  hiddenLocationWhyHere: locationName =>
    `O rută subtilă se desprinde din ${locationName}.`,
  itemProvenance: anchorName =>
    `Urma aparține lui ${anchorName} sau scenei curente, nu încă jucătorului.`,
  secretText: anchorName => `Un mic indiciu este prezent lângă ${anchorName}.`,
  npcClueText: anchorName =>
    `${anchorName} poate indica indiciul fără să ofere o recompensă.`,
  locationClueText: anchorName =>
    `Împrejurimile lângă ${anchorName} arată un semn fizic.`,
  bridgeSummary: title => `Complicație de rezervă legată de "${title}".`,
  bridgeGoalText: title => `Integrează acest indiciu în "${title}".`,
};

const HE_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'להבחין ברמז',
  followStageTitle: 'לעקוב אחרי הרמז',
  timingClueText: 'העיתוי הופך את הרמז לגלוי עכשיו.',
  acceptCondition: 'לקבל את הרמז ולבדוק אותו בסצנה הנוכחית.',
  goalText: 'לחקור את הרמז ולהחליט אם יש לו משמעות.',
  title: (kind, anchorName) => `${hebrewKindTitle(kind)} ליד ${anchorName}`,
  genericHook: anchorName =>
    `רמז שקט ליד @${anchorName} פותח חוט הרפתקה קטן, אבל צריך בחירה מודעת לפני שהוא הופך לקאנון.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `רמז שקט ליד @${anchorName} מצביע אל @${locationName}, אבל צריך בדיקה לפני שזה ודאי.`,
  hiddenLocationName: queueId => `דרך נסתרת ${queueId}`,
  itemName: queueId => `עקבה לא נתבעת ${queueId}`,
  questCauseClaim: title =>
    `המשימה הפעילה "${title}" יכולה להכיל סיבוך בטוח.`,
  entityCauseClaim: anchorName =>
    `${anchorName} מספק עוגן עולמי מספיק לרמז קטן.`,
  hiddenLocationWhyHere: locationName =>
    `מסלול דק מסתעף מתוך ${locationName}.`,
  itemProvenance: anchorName =>
    `העקבה שייכת ל-${anchorName} או לסצנה הנוכחית, עדיין לא לשחקן.`,
  secretText: anchorName => `רמז קטן נמצא ליד ${anchorName}.`,
  npcClueText: anchorName =>
    `${anchorName} יכול להצביע על הרמז בלי לתת פרס.`,
  locationClueText: anchorName =>
    `הסביבה ליד ${anchorName} מציגה סימן פיזי.`,
  bridgeSummary: title => `סיבוך גיבוי נקשר אל "${title}".`,
  bridgeGoalText: title => `לשלב את הרמז הזה בתוך "${title}".`,
};

const AR_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'ملاحظة الخيط',
  followStageTitle: 'اتباع الخيط',
  timingClueText: 'توقيت اللحظة يجعل الخيط واضحا الآن.',
  acceptCondition: 'اقبل الخيط وحققه في المشهد الحالي.',
  goalText: 'حقق في الخيط وقرر إن كان مهما.',
  title: (kind, anchorName) => `${arabicKindTitle(kind)} قرب ${anchorName}`,
  genericHook: anchorName =>
    `خيط هادئ قرب @${anchorName} يفتح مسار مغامرة صغيرا، لكنه يحتاج إلى اختيار واع قبل أن يصبح جزءا من الحقيقة.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `خيط هادئ قرب @${anchorName} يشير إلى @${locationName}، لكنه يحتاج إلى تحقيق قبل أن يصبح مؤكدا.`,
  hiddenLocationName: queueId => `طريق غير معلن ${queueId}`,
  itemName: queueId => `أثر غير مملوك ${queueId}`,
  questCauseClaim: title =>
    `المهمة النشطة "${title}" يمكنها استيعاب تعقيد آمن.`,
  entityCauseClaim: anchorName =>
    `${anchorName} يقدم سياقا عالميا كافيا لخيط صغير.`,
  hiddenLocationWhyHere: locationName =>
    `مسار خفي يتفرع من ${locationName}.`,
  itemProvenance: anchorName =>
    `الأثر يخص ${anchorName} أو المشهد الحالي، وليس اللاعب بعد.`,
  secretText: anchorName => `يوجد خيط صغير قرب ${anchorName}.`,
  npcClueText: anchorName =>
    `${anchorName} يمكن أن يشير إلى الخيط دون منح مكافأة.`,
  locationClueText: anchorName =>
    `المحيط قرب ${anchorName} يظهر علامة مادية.`,
  bridgeSummary: title => `تعقيد احتياطي مرتبط بـ "${title}".`,
  bridgeGoalText: title => `ادمج هذا الخيط في "${title}".`,
};

const FA_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'دیدن سرنخ',
  followStageTitle: 'دنبال کردن سرنخ',
  timingClueText: 'زمان این لحظه سرنخ را اکنون آشکار می کند.',
  acceptCondition: 'سرنخ را بپذیر و آن را در صحنه فعلی بررسی کن.',
  goalText: 'سرنخ را بررسی کن و تصمیم بگیر آیا اهمیت دارد.',
  title: (kind, anchorName) => `${persianKindTitle(kind)} نزدیک ${anchorName}`,
  genericHook: anchorName =>
    `سرنخی آرام نزدیک @${anchorName} یک رشته کوچک ماجراجویی باز می کند، اما پیش از canon شدن به انتخاب آگاهانه نیاز دارد.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `سرنخی آرام نزدیک @${anchorName} به @${locationName} اشاره می کند، اما پیش از قطعی شدن باید بررسی شود.`,
  hiddenLocationName: queueId => `راه بی نشان ${queueId}`,
  itemName: queueId => `اثر بی صاحب ${queueId}`,
  questCauseClaim: title =>
    `ماموریت فعال "${title}" می تواند یک پیچیدگی امن را بپذیرد.`,
  entityCauseClaim: anchorName =>
    `${anchorName} پشتوانه درون جهانی کافی برای یک سرنخ کوچک فراهم می کند.`,
  hiddenLocationWhyHere: locationName =>
    `راهی کم پیدا از ${locationName} جدا می شود.`,
  itemProvenance: anchorName =>
    `این اثر به ${anchorName} یا صحنه فعلی مربوط است و هنوز متعلق به بازیکن نیست.`,
  secretText: anchorName => `سرنخی کوچک نزدیک ${anchorName} وجود دارد.`,
  npcClueText: anchorName =>
    `${anchorName} می تواند بدون دادن پاداش به سرنخ اشاره کند.`,
  locationClueText: anchorName =>
    `محیط نزدیک ${anchorName} نشانه ای فیزیکی نشان می دهد.`,
  bridgeSummary: title => `پیچیدگی پشتیبان به "${title}" وصل شد.`,
  bridgeGoalText: title => `این سرنخ را در "${title}" وارد کن.`,
};

const UR_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'سراغ دیکھنا',
  followStageTitle: 'سراغ کا پیچھا کرنا',
  timingClueText: 'اس لمحے کا وقت سراغ کو ابھی نمایاں بناتا ہے۔',
  acceptCondition: 'سراغ قبول کریں اور موجودہ منظر میں اس کی جانچ کریں۔',
  goalText: 'سراغ کی جانچ کریں اور فیصلہ کریں کہ یہ اہم ہے یا نہیں۔',
  title: (kind, anchorName) => `${urduKindTitle(kind)} ${anchorName} کے قریب`,
  genericHook: anchorName =>
    `@${anchorName} کے قریب ایک خاموش سراغ چھوٹی مہم کا دھاگا کھولتا ہے، مگر canon بننے سے پہلے شعوری انتخاب ضروری ہے۔`,
  hiddenLocationHook: (anchorName, locationName) =>
    `@${anchorName} کے قریب ایک خاموش سراغ @${locationName} کی طرف اشارہ کرتا ہے، مگر یقینی ہونے سے پہلے تحقیق ضروری ہے۔`,
  hiddenLocationName: queueId => `بے نشان راستہ ${queueId}`,
  itemName: queueId => `بے دعوی نشان ${queueId}`,
  questCauseClaim: title =>
    `فعال quest "${title}" ایک محفوظ پیچیدگی قبول کر سکتی ہے۔`,
  entityCauseClaim: anchorName =>
    `${anchorName} ایک چھوٹے سراغ کے لئے کافی اندرونی دنیاوی بنیاد دیتا ہے۔`,
  hiddenLocationWhyHere: locationName =>
    `${locationName} سے ایک باریک راستہ نکلتا ہے۔`,
  itemProvenance: anchorName =>
    `یہ نشان ${anchorName} یا موجودہ منظر سے وابستہ ہے، ابھی کھلاڑی کا نہیں۔`,
  secretText: anchorName => `${anchorName} کے قریب ایک چھوٹا سراغ موجود ہے۔`,
  npcClueText: anchorName =>
    `${anchorName} انعام دیے بغیر سراغ کی طرف اشارہ کر سکتا ہے۔`,
  locationClueText: anchorName =>
    `${anchorName} کے قریب ماحول ایک جسمانی نشان دکھاتا ہے۔`,
  bridgeSummary: title => `محفوظ پیچیدگی "${title}" سے جوڑی گئی۔`,
  bridgeGoalText: title => `اس سراغ کو "${title}" میں شامل کریں۔`,
};

const HI_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'सुराग देखना',
  followStageTitle: 'सुराग का पीछा करना',
  timingClueText: 'इस क्षण का समय सुराग को अभी स्पष्ट बनाता है।',
  acceptCondition: 'सुराग स्वीकार करें और मौजूदा दृश्य में उसकी जांच करें।',
  goalText: 'सुराग की जांच करें और तय करें कि वह मायने रखता है या नहीं।',
  title: (kind, anchorName) => `${hindiKindTitle(kind)} ${anchorName} के पास`,
  genericHook: anchorName =>
    `@${anchorName} के पास एक शांत सुराग छोटी साहसिक डोर खोलता है, लेकिन canon बनने से पहले सचेत चुनाव चाहिए।`,
  hiddenLocationHook: (anchorName, locationName) =>
    `@${anchorName} के पास एक शांत सुराग @${locationName} की ओर इशारा करता है, लेकिन निश्चित होने से पहले जांच चाहिए।`,
  hiddenLocationName: queueId => `अचिह्नित रास्ता ${queueId}`,
  itemName: queueId => `अदावा रहित निशान ${queueId}`,
  questCauseClaim: title =>
    `सक्रिय quest "${title}" सुरक्षित जटिलता स्वीकार कर सकती है।`,
  entityCauseClaim: anchorName =>
    `${anchorName} छोटे सुराग के लिए पर्याप्त आंतरिक आधार देता है।`,
  hiddenLocationWhyHere: locationName =>
    `${locationName} से एक हल्का रास्ता अलग होता है।`,
  itemProvenance: anchorName =>
    `यह निशान ${anchorName} या मौजूदा दृश्य से जुड़ा है, खिलाड़ी से अभी नहीं।`,
  secretText: anchorName => `${anchorName} के पास एक छोटा सुराग मौजूद है।`,
  npcClueText: anchorName =>
    `${anchorName} बिना इनाम दिए सुराग की ओर संकेत कर सकता है।`,
  locationClueText: anchorName =>
    `${anchorName} के पास का माहौल एक भौतिक संकेत दिखाता है।`,
  bridgeSummary: title => `सुरक्षित जटिलता "${title}" से जुड़ी है।`,
  bridgeGoalText: title => `इस सुराग को "${title}" में जोड़ें।`,
};

const MR_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'धागा लक्षात घेणे',
  followStageTitle: 'धाग्याचा मागोवा घेणे',
  timingClueText: 'या क्षणाची वेळ हा धागा आत्ता स्पष्ट करते.',
  acceptCondition: 'धागा स्वीकारा आणि सध्याच्या दृश्यात त्याची चौकशी करा.',
  goalText: 'धाग्याची चौकशी करा आणि तो महत्त्वाचा आहे का ते ठरवा.',
  title: (kind, anchorName) => `${marathiKindTitle(kind)} ${anchorName} जवळ`,
  genericHook: anchorName =>
    `@${anchorName} जवळचा शांत धागा छोटी साहसी रेषा उघडतो, पण canon होण्यापूर्वी जाणीवपूर्वक निवड हवी.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `@${anchorName} जवळचा शांत धागा @${locationName} कडे दाखवतो, पण खात्री होण्यापूर्वी चौकशी हवी.`,
  hiddenLocationName: queueId => `न खुणावलेला मार्ग ${queueId}`,
  itemName: queueId => `न दावा केलेला माग ${queueId}`,
  questCauseClaim: title =>
    `सक्रिय quest "${title}" सुरक्षित गुंतागुंत स्वीकारू शकते.`,
  entityCauseClaim: anchorName =>
    `${anchorName} छोट्या धाग्यासाठी पुरेसा अंतर्गत जगाचा आधार देतो.`,
  hiddenLocationWhyHere: locationName =>
    `${locationName} पासून हलका मार्ग फुटतो.`,
  itemProvenance: anchorName =>
    `हा माग ${anchorName} किंवा सध्याच्या दृश्याशी जोडलेला आहे, अजून खेळाडूचा नाही.`,
  secretText: anchorName => `${anchorName} जवळ एक छोटा धागा आहे.`,
  npcClueText: anchorName =>
    `${anchorName} बक्षीस न देता धाग्याकडे इशारा करू शकतो.`,
  locationClueText: anchorName =>
    `${anchorName} जवळचे वातावरण भौतिक चिन्ह दाखवते.`,
  bridgeSummary: title => `राखीव गुंतागुंत "${title}" शी जोडली आहे.`,
  bridgeGoalText: title => `हा धागा "${title}" मध्ये गुंफा.`,
};

const NE_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'सुराग देख्नु',
  followStageTitle: 'सुराग पछ्याउनु',
  timingClueText: 'यस क्षणको समयले सुरागलाई अहिले देखिने बनाउँछ।',
  acceptCondition: 'सुराग स्वीकार गरेर हालको दृश्यमा जाँच गर्नु।',
  goalText: 'सुराग जाँच गरेर यसको महत्व छ कि छैन निर्णय गर्नु।',
  title: (kind, anchorName) => `${nepaliKindTitle(kind)} ${anchorName} नजिक`,
  genericHook: anchorName =>
    `@${anchorName} नजिकको शान्त सुरागले सानो साहसिक धागो खोल्छ, तर canon बन्नुअघि सचेत छनोट चाहिन्छ।`,
  hiddenLocationHook: (anchorName, locationName) =>
    `@${anchorName} नजिकको शान्त सुरागले @${locationName} तिर देखाउँछ, तर निश्चित हुनुअघि जाँच चाहिन्छ।`,
  hiddenLocationName: queueId => `अचिन्हित बाटो ${queueId}`,
  itemName: queueId => `दाबी नगरिएको चिन्ह ${queueId}`,
  questCauseClaim: title =>
    `सक्रिय quest "${title}" ले सुरक्षित जटिलता लिन सक्छ।`,
  entityCauseClaim: anchorName =>
    `${anchorName} सानो सुरागका लागि पर्याप्त विश्वभित्रको आधार दिन्छ।`,
  hiddenLocationWhyHere: locationName =>
    `${locationName} बाट हल्का बाटो छुट्टिन्छ।`,
  itemProvenance: anchorName =>
    `यो चिन्ह ${anchorName} वा हालको दृश्यसँग जोडिएको छ, अझै खेलाडीको होइन।`,
  secretText: anchorName => `${anchorName} नजिक सानो सुराग छ।`,
  npcClueText: anchorName =>
    `${anchorName} ले पुरस्कार नदिई सुरागतिर संकेत गर्न सक्छ।`,
  locationClueText: anchorName =>
    `${anchorName} नजिकको वातावरणले भौतिक चिन्ह देखाउँछ।`,
  bridgeSummary: title => `राखिएको जटिलता "${title}" सँग जोडिएको छ।`,
  bridgeGoalText: title => `यो सुरागलाई "${title}" मा गाँस्नु।`,
};

const BN_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'সূত্রটি খেয়াল করা',
  followStageTitle: 'সূত্রটি অনুসরণ করা',
  timingClueText: 'এই মুহূর্তের সময় সূত্রটিকে এখন চোখে পড়ার মতো করেছে।',
  acceptCondition: 'সূত্রটি গ্রহণ করে বর্তমান দৃশ্যে তদন্ত করা।',
  goalText: 'সূত্রটি তদন্ত করে তার গুরুত্ব আছে কি না ঠিক করা।',
  title: (kind, anchorName) => `${bengaliKindTitle(kind)} ${anchorName} এর কাছে`,
  genericHook: anchorName =>
    `@${anchorName} এর কাছে একটি নীরব সূত্র ছোট অভিযানের সুতো খুলছে, কিন্তু canon হওয়ার আগে সচেতন সিদ্ধান্ত দরকার।`,
  hiddenLocationHook: (anchorName, locationName) =>
    `@${anchorName} এর কাছে একটি নীরব সূত্র @${locationName} এর দিকে ইঙ্গিত করছে, কিন্তু নিশ্চিত হওয়ার আগে তদন্ত দরকার।`,
  hiddenLocationName: queueId => `অচিহ্নিত পথ ${queueId}`,
  itemName: queueId => `অদাবিকৃত চিহ্ন ${queueId}`,
  questCauseClaim: title =>
    `সক্রিয় quest "${title}" নিরাপদ জটিলতা নিতে পারে।`,
  entityCauseClaim: anchorName =>
    `${anchorName} ছোট সূত্রের জন্য যথেষ্ট জগতভিত্তিক ভরসা দেয়।`,
  hiddenLocationWhyHere: locationName =>
    `${locationName} থেকে একটি সূক্ষ্ম পথ আলাদা হয়েছে।`,
  itemProvenance: anchorName =>
    `চিহ্নটি ${anchorName} বা বর্তমান দৃশ্যের, খেলোয়াড়ের নয়।`,
  secretText: anchorName => `${anchorName} এর কাছে একটি ছোট সূত্র আছে।`,
  npcClueText: anchorName =>
    `${anchorName} পুরস্কার না দিয়েই সূত্রের দিকে ইঙ্গিত করতে পারে।`,
  locationClueText: anchorName =>
    `${anchorName} এর আশপাশে একটি বাস্তব চিহ্ন দেখা যায়।`,
  bridgeSummary: title => `রিজার্ভ জটিলতা "${title}" এর সঙ্গে যুক্ত।`,
  bridgeGoalText: title => `এই সূত্রটি "${title}" এর মধ্যে জুড়ে দাও।`,
};

const TH_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'สังเกตเบาะแส',
  followStageTitle: 'ตามเบาะแส',
  timingClueText: 'จังหวะของเหตุการณ์ทำให้เบาะแสนี้มองเห็นได้ตอนนี้',
  acceptCondition: 'รับเบาะแสและตรวจสอบในฉากปัจจุบัน',
  goalText: 'ตรวจสอบเบาะแสและตัดสินว่ามันสำคัญหรือไม่',
  title: (kind, anchorName) => `${thaiKindTitle(kind)} ใกล้ ${anchorName}`,
  genericHook: anchorName =>
    `เบาะแสเงียบๆ ใกล้ @${anchorName} เปิดเส้นการผจญภัยเล็กๆ แต่ต้องมีการตัดสินใจก่อนจะกลายเป็น canon`,
  hiddenLocationHook: (anchorName, locationName) =>
    `เบาะแสเงียบๆ ใกล้ @${anchorName} ชี้ไปที่ @${locationName} แต่ต้องตรวจสอบก่อนจะแน่ชัด`,
  hiddenLocationName: queueId => `ทางที่ยังไม่ถูกทำเครื่องหมาย ${queueId}`,
  itemName: queueId => `ร่องรอยที่ยังไม่มีเจ้าของ ${queueId}`,
  questCauseClaim: title =>
    `ภารกิจที่กำลังดำเนินอยู่ "${title}" รองรับความซับซ้อนที่ปลอดภัยได้`,
  entityCauseClaim: anchorName =>
    `${anchorName} มีบริบทในโลกเพียงพอสำหรับเบาะแสเล็กๆ`,
  hiddenLocationWhyHere: locationName =>
    `มีเส้นทางแยกอย่างแนบเนียนจาก ${locationName}`,
  itemProvenance: anchorName =>
    `ร่องรอยนี้เกี่ยวกับ ${anchorName} หรือฉากปัจจุบัน ยังไม่ใช่ของผู้เล่น`,
  secretText: anchorName => `มีเบาะแสเล็กๆ อยู่ใกล้ ${anchorName}`,
  npcClueText: anchorName =>
    `${anchorName} ชี้ไปยังเบาะแสได้โดยไม่ให้รางวัลทันที`,
  locationClueText: anchorName =>
    `สภาพแวดล้อมใกล้ ${anchorName} แสดงสัญญาณทางกายภาพ`,
  bridgeSummary: title => `ความซับซ้อนสำรองถูกผูกกับ "${title}"`,
  bridgeGoalText: title => `สอดเบาะแสนี้เข้าไปใน "${title}"`,
};

const EL_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'Παρατήρηση του στοιχείου',
  followStageTitle: 'Ακολούθηση του στοιχείου',
  timingClueText: 'Η στιγμή κάνει το στοιχείο ορατό τώρα.',
  acceptCondition: 'Αποδέξου το στοιχείο και εξέτασέ το στην τρέχουσα σκηνή.',
  goalText: 'Ερεύνησε το στοιχείο και αποφάσισε αν έχει σημασία.',
  title: (kind, anchorName) => `${greekKindTitle(kind)} κοντά σε ${anchorName}`,
  genericHook: anchorName =>
    `Ένα ήσυχο στοιχείο κοντά σε @${anchorName} ανοίγει ένα μικρό νήμα περιπέτειας, αλλά χρειάζεται συνειδητή επιλογή πριν γίνει canon.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `Ένα ήσυχο στοιχείο κοντά σε @${anchorName} δείχνει προς @${locationName}, αλλά χρειάζεται έρευνα πριν θεωρηθεί βέβαιο.`,
  hiddenLocationName: queueId => `Ασημείωτο πέρασμα ${queueId}`,
  itemName: queueId => `Αζήτητο ίχνος ${queueId}`,
  questCauseClaim: title =>
    `Η ενεργή αποστολή "${title}" μπορεί να δεχτεί ασφαλή επιπλοκή.`,
  entityCauseClaim: anchorName =>
    `${anchorName} προσφέρει αρκετή εσωτερική βάση για ένα μικρό στοιχείο.`,
  hiddenLocationWhyHere: locationName =>
    `Μια διακριτική διαδρομή ξεκινά από ${locationName}.`,
  itemProvenance: anchorName =>
    `Το ίχνος ανήκει σε ${anchorName} ή στην τρέχουσα σκηνή, όχι ακόμα στον παίκτη.`,
  secretText: anchorName => `Ένα μικρό στοιχείο υπάρχει κοντά σε ${anchorName}.`,
  npcClueText: anchorName =>
    `${anchorName} μπορεί να δείξει το στοιχείο χωρίς να δώσει ανταμοιβή.`,
  locationClueText: anchorName =>
    `Το περιβάλλον κοντά σε ${anchorName} δείχνει φυσικό σημάδι.`,
  bridgeSummary: title => `Εφεδρική επιπλοκή συνδεδεμένη με "${title}".`,
  bridgeGoalText: title => `Ένταξε αυτό το στοιχείο στο "${title}".`,
};

const HY_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'Նկատել հուշումը',
  followStageTitle: 'Հետևել հուշմանը',
  timingClueText: 'Այս պահի ժամանակը հուշումը հիմա տեսանելի է դարձնում։',
  acceptCondition: 'Ընդունել հուշումը և ուսումնասիրել այն ընթացիկ տեսարանում։',
  goalText: 'Ուսումնասիրել հուշումը և որոշել, արդյոք այն կարևոր է։',
  title: (kind, anchorName) => `${armenianKindTitle(kind)} ${anchorName}-ի մոտ`,
  genericHook: anchorName =>
    `@${anchorName}-ի մոտ հանգիստ հուշումը բացում է փոքր արկածային թել, բայց մինչ canon դառնալը պետք է գիտակցված ընտրություն։`,
  hiddenLocationHook: (anchorName, locationName) =>
    `@${anchorName}-ի մոտ հանգիստ հուշումը ցույց է տալիս @${locationName}, բայց պետք է ստուգել մինչև հաստատվելը։`,
  hiddenLocationName: queueId => `Չնշված ուղի ${queueId}`,
  itemName: queueId => `Չվերցված հետք ${queueId}`,
  questCauseClaim: title =>
    `Ակտիվ quest-ը "${title}" կարող է ընդունել անվտանգ բարդացում։`,
  entityCauseClaim: anchorName =>
    `${anchorName} տալիս է բավարար աշխարհային հիմք փոքր հուշման համար։`,
  hiddenLocationWhyHere: locationName =>
    `${locationName}-ից բաժանվում է հազիվ տեսանելի ուղի։`,
  itemProvenance: anchorName =>
    `Հետքը կապված է ${anchorName}-ի կամ ընթացիկ տեսարանի հետ և դեռ խաղացողինը չէ։`,
  secretText: anchorName => `${anchorName}-ի մոտ կա փոքր հուշում։`,
  npcClueText: anchorName =>
    `${anchorName} կարող է ցույց տալ հուշումը առանց պարգև տալու։`,
  locationClueText: anchorName =>
    `${anchorName}-ի մոտ միջավայրը ֆիզիկական նշան է ցույց տալիս։`,
  bridgeSummary: title => `Պահեստային բարդացումը կապված է "${title}"-ի հետ։`,
  bridgeGoalText: title => `Այս հուշումը միացրու "${title}"-ին։`,
};

const KA_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: 'მინიშნების შემჩნევა',
  followStageTitle: 'მინიშნების გაყოლა',
  timingClueText: 'ამ მომენტის დრო მინიშნებას ახლა შესამჩნევს ხდის.',
  acceptCondition: 'მიიღე მინიშნება და შეამოწმე მიმდინარე სცენაში.',
  goalText: 'გამოიკვლიე მინიშნება და გადაწყვიტე, აქვს თუ არა მნიშვნელობა.',
  title: (kind, anchorName) => `${georgianKindTitle(kind)} ${anchorName}-თან`,
  genericHook: anchorName =>
    `@${anchorName}-თან ჩუმი მინიშნება პატარა სათავგადასავლო ხაზს ხსნის, მაგრამ canon-მდე გააზრებული არჩევანი სჭირდება.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `@${anchorName}-თან ჩუმი მინიშნება @${locationName}-ზე მიუთითებს, მაგრამ დამტკიცებამდე შემოწმება სჭირდება.`,
  hiddenLocationName: queueId => `უმარკო გზა ${queueId}`,
  itemName: queueId => `უპატრონო კვალი ${queueId}`,
  questCauseClaim: title =>
    `აქტიურ quest-ს "${title}" შეუძლია უსაფრთხო გართულების მიღება.`,
  entityCauseClaim: anchorName =>
    `${anchorName} პატარა მინიშნებისთვის საკმარის სამყაროსეულ საყრდენს იძლევა.`,
  hiddenLocationWhyHere: locationName =>
    `${locationName}-დან შეუმჩნეველი ბილიკი იყოფა.`,
  itemProvenance: anchorName =>
    `კვალი უკავშირდება ${anchorName}-ს ან მიმდინარე სცენას და ჯერ მოთამაშეს არ ეკუთვნის.`,
  secretText: anchorName => `${anchorName}-თან პატარა მინიშნება არის.`,
  npcClueText: anchorName =>
    `${anchorName} შეუძლია მინიშნებაზე მიუთითოს ჯილდოს მიცემის გარეშე.`,
  locationClueText: anchorName =>
    `${anchorName}-თან გარემო ფიზიკურ ნიშანს აჩვენებს.`,
  bridgeSummary: title => `სარეზერვო გართულება დაკავშირებულია "${title}"-თან.`,
  bridgeGoalText: title => `ეს მინიშნება ჩართე "${title}"-ში.`,
};

const KO_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: '단서 알아차리기',
  followStageTitle: '단서 따라가기',
  timingClueText: '지금 이 순간의 흐름이 단서를 드러나게 합니다.',
  acceptCondition: '단서를 받아들이고 현재 장면에서 조사합니다.',
  goalText: '단서를 조사하고 그것이 중요한지 판단합니다.',
  title: (kind, anchorName) => `${koreanKindTitle(kind)}: ${anchorName} 근처`,
  genericHook: anchorName =>
    `@${anchorName} 근처의 조용한 단서가 작은 모험의 실마리를 열지만, canon이 되기 전에는 의식적인 선택이 필요합니다.`,
  hiddenLocationHook: (anchorName, locationName) =>
    `@${anchorName} 근처의 조용한 단서가 @${locationName} 쪽을 가리키지만, 확실해지기 전에는 조사가 필요합니다.`,
  hiddenLocationName: queueId => `표시되지 않은 길 ${queueId}`,
  itemName: queueId => `주인 없는 흔적 ${queueId}`,
  questCauseClaim: title =>
    `진행 중인 quest "${title}"은 안전한 변수를 받아들일 수 있습니다.`,
  entityCauseClaim: anchorName =>
    `${anchorName}은 작은 단서에 충분한 세계 내부 근거를 제공합니다.`,
  hiddenLocationWhyHere: locationName =>
    `${locationName}에서 희미한 길이 갈라집니다.`,
  itemProvenance: anchorName =>
    `이 흔적은 ${anchorName} 또는 현재 장면에 속하며 아직 플레이어의 것이 아닙니다.`,
  secretText: anchorName => `${anchorName} 근처에 작은 단서가 있습니다.`,
  npcClueText: anchorName =>
    `${anchorName}은 보상 없이 단서를 가리킬 수 있습니다.`,
  locationClueText: anchorName =>
    `${anchorName} 근처의 주변 환경에 물리적인 표식이 보입니다.`,
  bridgeSummary: title => `"${title}"에 예비 변수가 연결되었습니다.`,
  bridgeGoalText: title => `이 단서를 "${title}"에 엮습니다.`,
};

const JA_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: '手がかりに気づく',
  followStageTitle: '手がかりを追う',
  timingClueText: 'この瞬間の流れが、手がかりをいま見えるものにしている。',
  acceptCondition: '手がかりを受け入れ、現在の場面で調べる。',
  goalText: '手がかりを調べ、それに意味があるか判断する。',
  title: (kind, anchorName) => `${japaneseKindTitle(kind)}：${anchorName}の近く`,
  genericHook: anchorName =>
    `@${anchorName}の近くに静かな手がかりがあり、小さな冒険の糸口を開く。ただしcanonになる前に、意識的な選択が必要だ。`,
  hiddenLocationHook: (anchorName, locationName) =>
    `@${anchorName}の近くの静かな手がかりは@${locationName}を指しているが、確定する前に調査が必要だ。`,
  hiddenLocationName: queueId => `印のない道 ${queueId}`,
  itemName: queueId => `未取得の痕跡 ${queueId}`,
  questCauseClaim: title =>
    `進行中のquest「${title}」は安全な複雑化を受け入れられる。`,
  entityCauseClaim: anchorName =>
    `${anchorName}には、小さな手がかりを支える世界内の根拠がある。`,
  hiddenLocationWhyHere: locationName =>
    `${locationName}からかすかな道が分かれている。`,
  itemProvenance: anchorName =>
    `この痕跡は${anchorName}か現在の場面に属し、まだプレイヤーのものではない。`,
  secretText: anchorName => `${anchorName}の近くに小さな手がかりがある。`,
  npcClueText: anchorName =>
    `${anchorName}は報酬を与えずに手がかりを示せる。`,
  locationClueText: anchorName =>
    `${anchorName}の周囲には物理的な兆しがある。`,
  bridgeSummary: title => `予備の複雑化が「${title}」に結び付けられた。`,
  bridgeGoalText: title => `この手がかりを「${title}」に組み込む。`,
};

const ZH_FALLBACK_TEXT: AdventureFallbackTextPack = {
  noticeStageTitle: '注意线索',
  followStageTitle: '追踪线索',
  timingClueText: '此刻的时机让这条线索显现出来。',
  acceptCondition: '接受线索，并在当前场景中调查。',
  goalText: '调查线索，并判断它是否重要。',
  title: (kind, anchorName) => `${chineseKindTitle(kind)}：${anchorName}附近`,
  genericHook: anchorName =>
    `@${anchorName}附近出现一条安静的线索，开启一段小冒险，但在成为canon之前需要玩家明确选择。`,
  hiddenLocationHook: (anchorName, locationName) =>
    `@${anchorName}附近出现一条安静的线索，指向@${locationName}，但需要调查后才能确认。`,
  hiddenLocationName: queueId => `未标记路径 ${queueId}`,
  itemName: queueId => `未归属痕迹 ${queueId}`,
  questCauseClaim: title =>
    `进行中的quest“${title}”可以承接一个安全的变故。`,
  entityCauseClaim: anchorName =>
    `${anchorName}提供了足够的世界内依据来支撑一条小线索。`,
  hiddenLocationWhyHere: locationName =>
    `一条隐约的路线从${locationName}分出。`,
  itemProvenance: anchorName =>
    `这道痕迹属于${anchorName}或当前场景，尚未属于玩家。`,
  secretText: anchorName => `${anchorName}附近存在一条小线索。`,
  npcClueText: anchorName =>
    `${anchorName}可以指出线索，但不会立刻给予奖励。`,
  locationClueText: anchorName =>
    `${anchorName}附近的环境显示出物理痕迹。`,
  bridgeSummary: title => `备用变故已连接到“${title}”。`,
  bridgeGoalText: title => `将这条线索编入“${title}”。`,
};

export const FALLBACK_TEXT_BY_LANGUAGE: AdventureFallbackTextPackMap = {
  en: EN_FALLBACK_TEXT,
  ru: RU_FALLBACK_TEXT,
  uk: UK_FALLBACK_TEXT,
  bg: BG_FALLBACK_TEXT,
  sr: SR_FALLBACK_TEXT,
  es: ES_FALLBACK_TEXT,
  fr: FR_FALLBACK_TEXT,
  de: DE_FALLBACK_TEXT,
  it: IT_FALLBACK_TEXT,
  pt: PT_FALLBACK_TEXT,
  ro: RO_FALLBACK_TEXT,
  he: HE_FALLBACK_TEXT,
  ar: AR_FALLBACK_TEXT,
  fa: FA_FALLBACK_TEXT,
  ur: UR_FALLBACK_TEXT,
  hi: HI_FALLBACK_TEXT,
  mr: MR_FALLBACK_TEXT,
  ne: NE_FALLBACK_TEXT,
  bn: BN_FALLBACK_TEXT,
  th: TH_FALLBACK_TEXT,
  el: EL_FALLBACK_TEXT,
  hy: HY_FALLBACK_TEXT,
  ka: KA_FALLBACK_TEXT,
  ko: KO_FALLBACK_TEXT,
  ja: JA_FALLBACK_TEXT,
  zh: ZH_FALLBACK_TEXT,
};

export const FALLBACK_TEXT_BY_SCRIPT: Partial<
  Record<ScriptTag, AdventureFallbackTextPack>
> = {
  latin: EN_FALLBACK_TEXT,
  cyrillic: RU_FALLBACK_TEXT,
  hebrew: HE_FALLBACK_TEXT,
  arabic: AR_FALLBACK_TEXT,
  devanagari: HI_FALLBACK_TEXT,
  bengali: BN_FALLBACK_TEXT,
  thai: TH_FALLBACK_TEXT,
  greek: EL_FALLBACK_TEXT,
  armenian: HY_FALLBACK_TEXT,
  georgian: KA_FALLBACK_TEXT,
  hangul: KO_FALLBACK_TEXT,
  hiragana: JA_FALLBACK_TEXT,
  katakana: JA_FALLBACK_TEXT,
  han: ZH_FALLBACK_TEXT,
};

function spanishKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'Una palabra';
    case 'exploration_clue':
      return 'Una pista';
    case 'hidden_location':
      return 'Un camino no marcado';
    case 'item_discovery':
      return 'Un rastro';
    case 'hazard':
      return 'Un riesgo';
    case 'ambush':
      return 'Una mala señal';
    case 'quest_complication':
      return 'Una complicación';
    case 'downtime_rumor':
      return 'Un rumor';
    default:
      return 'Una pista';
  }
}

function ukrainianKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'Слово';
    case 'exploration_clue':
      return 'Зачіпка';
    case 'hidden_location':
      return 'Непозначений шлях';
    case 'item_discovery':
      return 'Слід';
    case 'hazard':
      return 'Ризик';
    case 'ambush':
      return 'Лихий знак';
    case 'quest_complication':
      return 'Ускладнення';
    case 'downtime_rumor':
      return 'Чутка';
    default:
      return 'Навідка';
  }
}

function bulgarianKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'Дума';
    case 'exploration_clue':
      return 'Следа';
    case 'hidden_location':
      return 'Немаркиран път';
    case 'item_discovery':
      return 'Нова следа';
    case 'hazard':
      return 'Риск';
    case 'ambush':
      return 'Лош знак';
    case 'quest_complication':
      return 'Усложнение';
    case 'downtime_rumor':
      return 'Слух';
    default:
      return 'Насока';
  }
}

function serbianKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'Реч';
    case 'exploration_clue':
      return 'Траг';
    case 'hidden_location':
      return 'Необележен пут';
    case 'item_discovery':
      return 'Нови траг';
    case 'hazard':
      return 'Ризик';
    case 'ambush':
      return 'Лош знак';
    case 'quest_complication':
      return 'Компликација';
    case 'downtime_rumor':
      return 'Гласина';
    default:
      return 'Навод';
  }
}

function frenchKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'Une parole';
    case 'exploration_clue':
      return 'Une piste';
    case 'hidden_location':
      return 'Un passage discret';
    case 'item_discovery':
      return 'Une trace';
    case 'hazard':
      return 'Un risque';
    case 'ambush':
      return 'Un mauvais signe';
    case 'quest_complication':
      return 'Une complication';
    case 'downtime_rumor':
      return 'Une rumeur';
    default:
      return 'Une piste';
  }
}

function germanKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'Ein Wort';
    case 'exploration_clue':
      return 'Ein Hinweis';
    case 'hidden_location':
      return 'Ein unmarkierter Weg';
    case 'item_discovery':
      return 'Eine Spur';
    case 'hazard':
      return 'Ein Risiko';
    case 'ambush':
      return 'Ein schlechtes Zeichen';
    case 'quest_complication':
      return 'Eine Komplikation';
    case 'downtime_rumor':
      return 'Ein Gerücht';
    default:
      return 'Ein Hinweis';
  }
}

function italianKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'Una parola';
    case 'exploration_clue':
      return 'Un indizio';
    case 'hidden_location':
      return 'Un passaggio nascosto';
    case 'item_discovery':
      return 'Una traccia';
    case 'hazard':
      return 'Un rischio';
    case 'ambush':
      return 'Un cattivo segno';
    case 'quest_complication':
      return 'Una complicazione';
    case 'downtime_rumor':
      return 'Una voce';
    default:
      return 'Un indizio';
  }
}

function portugueseKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'Uma palavra';
    case 'exploration_clue':
      return 'Uma pista';
    case 'hidden_location':
      return 'Um caminho oculto';
    case 'item_discovery':
      return 'Um rastro';
    case 'hazard':
      return 'Um risco';
    case 'ambush':
      return 'Um mau sinal';
    case 'quest_complication':
      return 'Uma complicação';
    case 'downtime_rumor':
      return 'Um rumor';
    default:
      return 'Uma pista';
  }
}

function romanianKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'Un cuvânt';
    case 'exploration_clue':
      return 'Un indiciu';
    case 'hidden_location':
      return 'Un drum nemarcat';
    case 'item_discovery':
      return 'O urmă';
    case 'hazard':
      return 'Un risc';
    case 'ambush':
      return 'Un semn rău';
    case 'quest_complication':
      return 'O complicație';
    case 'downtime_rumor':
      return 'Un zvon';
    default:
      return 'Un indiciu';
  }
}

function hebrewKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'מילה שקטה';
    case 'exploration_clue':
      return 'רמז חקירה';
    case 'hidden_location':
      return 'דרך לא מסומנת';
    case 'item_discovery':
      return 'עקבה חדשה';
    case 'hazard':
      return 'סיכון מקומי';
    case 'ambush':
      return 'סימן רע';
    case 'quest_complication':
      return 'סיבוך במשימה';
    case 'downtime_rumor':
      return 'שמועה מקומית';
    default:
      return 'רמז חדש';
  }
}

function arabicKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'كلمة هادئة';
    case 'exploration_clue':
      return 'خيط استكشاف';
    case 'hidden_location':
      return 'طريق غير معلن';
    case 'item_discovery':
      return 'أثر جديد';
    case 'hazard':
      return 'خطر محلي';
    case 'ambush':
      return 'علامة سيئة';
    case 'quest_complication':
      return 'تعقيد في المهمة';
    case 'downtime_rumor':
      return 'شائعة محلية';
    default:
      return 'خيط جديد';
  }
}

function persianKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'یک سخن آرام';
    case 'exploration_clue':
      return 'یک سرنخ کاوش';
    case 'hidden_location':
      return 'یک راه بی نشان';
    case 'item_discovery':
      return 'یک اثر تازه';
    case 'hazard':
      return 'یک خطر محلی';
    case 'ambush':
      return 'یک نشانه بد';
    case 'quest_complication':
      return 'یک پیچیدگی ماموریت';
    case 'downtime_rumor':
      return 'یک شایعه محلی';
    default:
      return 'یک سرنخ تازه';
  }
}

function urduKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'ایک خاموش بات';
    case 'exploration_clue':
      return 'تحقیقی سراغ';
    case 'hidden_location':
      return 'بے نشان راستہ';
    case 'item_discovery':
      return 'نیا نشان';
    case 'hazard':
      return 'مقامی خطرہ';
    case 'ambush':
      return 'برا شگون';
    case 'quest_complication':
      return 'quest کی پیچیدگی';
    case 'downtime_rumor':
      return 'مقامی افواہ';
    default:
      return 'نیا سراغ';
  }
}

function hindiKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'एक बातचीत का संकेत';
    case 'exploration_clue':
      return 'एक जांच का सुराग';
    case 'hidden_location':
      return 'एक अचिह्नित रास्ता';
    case 'item_discovery':
      return 'एक नया निशान';
    case 'hazard':
      return 'एक स्थानीय जोखिम';
    case 'ambush':
      return 'एक बुरा संकेत';
    case 'quest_complication':
      return 'quest की जटिलता';
    case 'downtime_rumor':
      return 'एक स्थानीय अफवाह';
    default:
      return 'एक नया सुराग';
  }
}

function marathiKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'एक शांत शब्द';
    case 'exploration_clue':
      return 'चौकशीचा धागा';
    case 'hidden_location':
      return 'न खुणावलेला मार्ग';
    case 'item_discovery':
      return 'नवा माग';
    case 'hazard':
      return 'स्थानिक धोका';
    case 'ambush':
      return 'वाईट चिन्ह';
    case 'quest_complication':
      return 'quest ची गुंतागुंत';
    case 'downtime_rumor':
      return 'स्थानिक अफवा';
    default:
      return 'नवा धागा';
  }
}

function nepaliKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'शान्त कुरा';
    case 'exploration_clue':
      return 'अनुसन्धान सुराग';
    case 'hidden_location':
      return 'अचिन्हित बाटो';
    case 'item_discovery':
      return 'नयाँ चिन्ह';
    case 'hazard':
      return 'स्थानीय जोखिम';
    case 'ambush':
      return 'नराम्रो संकेत';
    case 'quest_complication':
      return 'quest को जटिलता';
    case 'downtime_rumor':
      return 'स्थानीय अफवाह';
    default:
      return 'नयाँ सुराग';
  }
}

function bengaliKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'একটি কথার ইঙ্গিত';
    case 'exploration_clue':
      return 'একটি অনুসন্ধানী সূত্র';
    case 'hidden_location':
      return 'একটি অচিহ্নিত পথ';
    case 'item_discovery':
      return 'একটি নতুন চিহ্ন';
    case 'hazard':
      return 'একটি স্থানীয় ঝুঁকি';
    case 'ambush':
      return 'একটি অশুভ লক্ষণ';
    case 'quest_complication':
      return 'quest এর জটিলতা';
    case 'downtime_rumor':
      return 'একটি স্থানীয় গুজব';
    default:
      return 'একটি নতুন সূত্র';
  }
}

function thaiKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'คำพูดเล็กๆ';
    case 'exploration_clue':
      return 'เบาะแสสำรวจ';
    case 'hidden_location':
      return 'ทางที่ยังไม่ถูกทำเครื่องหมาย';
    case 'item_discovery':
      return 'ร่องรอยใหม่';
    case 'hazard':
      return 'ความเสี่ยงในพื้นที่';
    case 'ambush':
      return 'ลางไม่ดี';
    case 'quest_complication':
      return 'ความซับซ้อนของ quest';
    case 'downtime_rumor':
      return 'ข่าวลือในพื้นที่';
    default:
      return 'เบาะแสใหม่';
  }
}

function greekKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'Μια ήσυχη λέξη';
    case 'exploration_clue':
      return 'Ένα στοιχείο';
    case 'hidden_location':
      return 'Ένα ασημείωτο πέρασμα';
    case 'item_discovery':
      return 'Ένα νέο ίχνος';
    case 'hazard':
      return 'Ένας τοπικός κίνδυνος';
    case 'ambush':
      return 'Ένα κακό σημάδι';
    case 'quest_complication':
      return 'Μια επιπλοκή αποστολής';
    case 'downtime_rumor':
      return 'Μια τοπική φήμη';
    default:
      return 'Ένα νέο στοιχείο';
  }
}

function armenianKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'Լուռ խոսք';
    case 'exploration_clue':
      return 'Ուսումնասիրության հուշում';
    case 'hidden_location':
      return 'Չնշված ուղի';
    case 'item_discovery':
      return 'Նոր հետք';
    case 'hazard':
      return 'Տեղական վտանգ';
    case 'ambush':
      return 'Վատ նշան';
    case 'quest_complication':
      return 'quest-ի բարդացում';
    case 'downtime_rumor':
      return 'Տեղական լուր';
    default:
      return 'Նոր հուշում';
  }
}

function georgianKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return 'ჩუმი სიტყვა';
    case 'exploration_clue':
      return 'საძიებო მინიშნება';
    case 'hidden_location':
      return 'უმარკო გზა';
    case 'item_discovery':
      return 'ახალი კვალი';
    case 'hazard':
      return 'ადგილობრივი რისკი';
    case 'ambush':
      return 'ცუდი ნიშანი';
    case 'quest_complication':
      return 'quest-ის გართულება';
    case 'downtime_rumor':
      return 'ადგილობრივი ჭორი';
    default:
      return 'ახალი მინიშნება';
  }
}

function koreanKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return '조용한 말';
    case 'exploration_clue':
      return '탐색 단서';
    case 'hidden_location':
      return '표시되지 않은 길';
    case 'item_discovery':
      return '새로운 흔적';
    case 'hazard':
      return '지역 위험';
    case 'ambush':
      return '나쁜 징조';
    case 'quest_complication':
      return 'quest 변수';
    case 'downtime_rumor':
      return '지역 소문';
    default:
      return '새로운 단서';
  }
}

function japaneseKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return '静かな言葉';
    case 'exploration_clue':
      return '探索の手がかり';
    case 'hidden_location':
      return '印のない道';
    case 'item_discovery':
      return '新しい痕跡';
    case 'hazard':
      return '近くの危険';
    case 'ambush':
      return '悪い兆し';
    case 'quest_complication':
      return 'questの複雑化';
    case 'downtime_rumor':
      return '地元の噂';
    default:
      return '新しい手がかり';
  }
}

function chineseKindTitle(kind: AdventureKind | string): string {
  switch (kind) {
    case 'social_hook':
      return '安静的话头';
    case 'exploration_clue':
      return '探索线索';
    case 'hidden_location':
      return '未标记路径';
    case 'item_discovery':
      return '新的痕迹';
    case 'hazard':
      return '附近风险';
    case 'ambush':
      return '不祥迹象';
    case 'quest_complication':
      return 'quest变故';
    case 'downtime_rumor':
      return '本地传闻';
    default:
      return '新的线索';
  }
}
