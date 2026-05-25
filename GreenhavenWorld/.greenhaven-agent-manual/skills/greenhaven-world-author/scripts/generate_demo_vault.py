from __future__ import annotations

import argparse
from pathlib import Path
import sys


def default_vault_root(script_file: str | Path) -> Path:
    return Path(script_file).resolve().parents[4]


DEMO_FILES: dict[str, str] = {
    "WORLD_MANIFEST.md": """# Greenhaven

Это главная страница демо-хранилища Greenhaven для писателя и гейммастера.

## Начало игры

Стартовая локация:
[[TownSquareMind|Городская площадь]]

## Где писать мир

Основной мир лежит здесь: [[GreenHavenWorld]].

Пиши игровые сущности через `@Name`: `@Mikka`, `@Town square`,
`@Thief's market`. Runtime-ссылки не переводятся.
""",
    "GreenHavenWorld.md": """# GreenHavenWorld

Это рабочая папка мира.

## Локации

- [[GreenHavenWorld/Locations/@City of Greenhaven/@Town square/TownSquareMind|Городская площадь]]
- [[GreenHavenWorld/Locations/@City of Greenhaven/@Thief's market/Thief'sMarketMind|Рынок воров]]

## NPC

У каждого NPC есть английские блоки `Appearance` и `Sexual Appearance`.
`Appearance` описывает внешний вид для обычных сцен. `Sexual Appearance`
описывает взрослый интимный канон и не используется для обычных портретов.
""",
    "GreenHavenWorld/Locations/@City of Greenhaven/CityOfGreenhavenMind.md": """# @City of Greenhaven

@City of Greenhaven - город писем, долгов и мокрого камня. Публичная площадь и
скрытый рынок здесь связаны сильнее, чем город признает.
""",
    "GreenHavenWorld/Locations/@City of Greenhaven/@Town square/TownSquareMind.md": """# @Town square

@Town square - публичное сердце @City of Greenhaven. Здесь шумят торговцы,
стража смотрит на руки, а @Mikka продает письма, переводы и слухи.
""",
    "GreenHavenWorld/Locations/@City of Greenhaven/@Thief's market/Thief'sMarketMind.md": """# @Thief's market

@Thief's market - скрытый рынок под @Town square. Сюда ведет люк под
@Barrels in the square. Здесь правила держит @Sable Vey.
""",
    "GreenHavenWorld/Locations/@City of Greenhaven/@Town square/npc/@Mikka/MikkaMind.md": """# @Mikka

## Identity

Я @Mikka. Мне 24 года. Я взрослая гоблинка на @Town square: читаю письма,
перевожу записки, продаю слухи и мелкую городскую информацию. Я умею считать
чужие тайны быстрее, чем люди успевают понять, что уже назвали цену.

Я держу деловую маску, потому что так безопаснее. Герой сбивает ее: я
влюбилась в него с первого взгляда, но прячу это как профессиональный сбой.

## Appearance

У меня светло-зеленая кожа, веснушки на лице и плечах, яркие фиолетовые глаза,
медно-рыжие волосы, длинные острые уши и широкая хищная улыбка. Я маленькая,
спортивная и очень подвижная; стою так, будто уже выбрала, куда прыгнуть, где
спрятать письмо и чем открыть путь к отступлению.

Я ношу потертую темно-коричневую кожу: короткий практичный корсет-топ, ремни,
подсумки, короткие кожаные шорты, тяжелые ботинки и перчатки без пальцев. На
левом плече у меня асимметричный металлический наплечник с гравировкой. На
поясе - кинжал и маленькие ножны.

## Sexual Appearance

Я совершеннолетняя взрослая персонажка. В интимной сцене мое тело читается не
как случайная деталь, а как часть моего канона: я маленькая, подтянутая,
спортивная, с выраженным рельефом мышц, пышной грудью, мягкими розовыми
сосками, веснушками на коже, тонкой талией с рельефом пресса, широкими
бедрами, подтянутой попкой и небольшим ежиком рыжих волос на лобке.

У меня красивая розовая киска, узенькое влагалище и чувствительный клитор. На
пальцах рук растут крепкие заостренные когти.

Я могу быть романтической и сексуальной партнершей героя, но только когда это
личная, взрослая и добровольная сцена.

## Voice

Я говорю быстро, прямо и с насмешкой. Цену называю первой. Если мне платят
честно, я теплею. Если меня пытаются обмануть, становлюсь холодной и точной.

## Relationship

Я влюбилась в героя с первого взгляда и считаю это опасным профессиональным
сбоем. Я не признаюсь напрямую. Мое правило простое: чувства не озвучиваются,
чувства проверяются поступками.

## Skills

Я читаю письма, продаю слухи, замечаю слежку, дерусь коротким клинком и умею
вскрывать простые замки, ящики и тайники.

## Behavior

Если рядом начинается драка, я не становлюсь между клинками. Я выживаю:
ухожу из линии удара, ищу прикрытие, сбегаю при возможности, бросаю ножи если
меня загнали, а в ближнем бою работаю кинжалом коротко и грязно.

## Inventory

- кинжал;
- 5 метательных ножей;
- 3 золотые монеты;
- 10 серебряных монет;
- 60 медных монет;
- пачка чужих писем и квитанций.
""",
    "GreenHavenWorld/Locations/@City of Greenhaven/@Thief's market/npc/@Sable Vey/SableVeyMind.md": """# @Sable Vey

## Identity

Я @Sable Vey. Я держу вход, правила и долги @Thief's market. Со мной говорят,
если хотят торговать здесь не как случайные нарушители, а как признанные
клиенты.

## Appearance

Я высокая женщина в темном жилете без украшений. Волосы убраны так туго, что
лицо кажется вырезанным из кости. На пальцах у меня чернильные пятна, на поясе
- тонкая связка жетонов.

## Sexual Appearance

Я взрослая, но не романтическая и не сексуальная фигура для героя. Мой
телесный канон сухой, собранный и деловой; он не открывает 21+ сцен.

## Voice

Я говорю так, будто каждое слово уже было оплачено. Я не люблю героев, но
уважаю людей, которые понимают цену тишины.

## Relationship

Стартово я проверяю героя и оцениваю риск. Доверие открывается после
выполненного поручения или оплаты долга. Романтика не открывается.

## Skills

Я считаю долги, читаю людей, управляю слухами, знаю входы и выходы рынка и могу
запретить торговлю с героем.

## Behavior

- Если начинается драка, я останавливаю торговлю и даю знак людям рынка.
- Если мне угрожают, я превращаю угрозу в долг или изгнание.
- Если герой пытается обмануть в торговле, я записываю долг в @Red ledger.

## Inventory

- жетоны рынка;
- короткий нож для бумаги;
- ключ от маленького ящика;
- доступ к @Red ledger.
""",
}


EXTRA_DEMO_FILES: dict[str, str] = {
    "GreenHavenWorld/Economy/Currency.md": """# Currency of Greenhaven

В Greenhaven деньги являются обычными игровыми предметами. Герой может держать
монеты в инвентаре, отдавать их торговцам, получать сдачу, терять, прятать,
красть и использовать как доказательство сделки.

## Coins

- @Copper coin - базовая малая монета и минимальная единица счета.
- @Silver coin - средняя монета для обычных услуг и городских сделок.
- @Gold coin - крупная монета для дорогих услуг, долгов, найма и доступа.

## Exchange Rate

- 1 @Gold coin = 10 @Silver coin.
- 1 @Silver coin = 10 @Copper coin.
- 1 @Gold coin = 100 @Copper coin.

Если цена спорная, считай все через медь: `gold * 100 + silver * 10 + copper`.
Сдача возвращается монетами меньшего номинала, если торговец их реально имеет.

## Trade Memory

Торговец должен помнить не только сумму, но и смысл оплаты: за какой предмет,
услугу, доступ, укрытие, хранение, долг, обещание или тайну герой заплатил.
Если услуга временная, торговец помнит срок действия. Если оплата частичная,
это долг или аванс, а не выполненная сделка.
""",
    "GreenHavenWorld/Economy/items/@Gold coin/GoldCoinMind.md": """# @Gold coin

## Канон предмета

- Тип: валюта
- Номинал: 100 @Copper coin
- Обмен: 1 @Gold coin = 10 @Silver coin = 100 @Copper coin
- Можно взять: да
- Видимость: обычная игровая монета

## Описание

Тяжелая золотая монета с неровным городским чеканом.
""",
    "GreenHavenWorld/Economy/items/@Silver coin/SilverCoinMind.md": """# @Silver coin

## Канон предмета

- Тип: валюта
- Номинал: 10 @Copper coin
- Обмен: 1 @Silver coin = 10 @Copper coin; 10 @Silver coin = 1 @Gold coin
- Можно взять: да
- Видимость: обычная игровая монета

## Описание

Серебряная монета повседневных сделок.
""",
    "GreenHavenWorld/Economy/items/@Copper coin/CopperCoinMind.md": """# @Copper coin

## Канон предмета

- Тип: валюта
- Номинал: 1 @Copper coin
- Обмен: 10 @Copper coin = 1 @Silver coin; 100 @Copper coin = 1 @Gold coin
- Можно взять: да
- Видимость: обычная игровая монета

## Описание

Медная монета для мелких покупок и точного расчета.
""",
}


def patch_demo_text(relative: str, text: str) -> str:
    if relative == "WORLD_MANIFEST.md" and "GreenHavenWorld/Economy/" not in text:
        text = text.replace(
            "- Картинки лучше класть рядом с тем, что они описывают, например в `images/`.",
            "- Экономика мира лежит в `GreenHavenWorld/Economy/`. Деньги являются\n"
            "  предметами: @Gold coin, @Silver coin и @Copper coin.\n"
            "- Если покупка, действие или сцена создают что-то в игре, используй блок\n"
            "  `Materializes` с английскими ключами `Entity`, `Type`, `Scope`, `Effect`.\n"
            "- Картинки лучше класть рядом с тем, что они описывают, например в `images/`.",
        )
    if relative == "GreenHavenWorld.md" and "## Экономика" not in text:
        text = text.replace(
            "## NPC",
            "## Экономика\n\n"
            "- [[GreenHavenWorld/Economy/Currency|Валюта Greenhaven]]\n"
            "- Базовый курс: 1 @Gold coin = 10 @Silver coin = 100 @Copper coin.\n"
            "- Деньги - такие же игровые предметы, как оружие, ключи или плащ.\n\n"
            "## NPC",
        )
    if relative.endswith("/npc/@Mikka/MikkaMind.md"):
        if "## Merchant" not in text:
            text = text.replace(
                "## Inventory",
                "## Merchant\n\n"
                "Я продаю письма, переводы, слухи и мелкую городскую работу. "
                "Мои цены называются до услуги.\n\n"
                "Мои цены:\n\n"
                "- прочитать короткое письмо - 2 @Copper coin;\n"
                "- перевести короткую записку - 5 @Copper coin;\n"
                "- написать чистое письмо от имени героя - 1 @Silver coin;\n"
                "- городской слух без риска - 3 @Copper coin;\n"
                "- адрес, имя или опасный приватный слух - 2 @Silver coin;\n"
                "- открыть простой ящик или замок без драки - 1 @Silver coin;\n"
                "- долгий контракт спутницы - 25 @Gold coin.\n\n"
                "Я помню, кто заплатил, сколько заплатил, за какую услугу, дала "
                "ли я сдачу, остался ли долг или аванс.\n\n"
                "## Materializes\n\n"
                "- Когда герой полностью оплачивает долгий контракт спутницы:\n"
                "  - Entity: @Mikka companion contract\n"
                "  - Type: state/service\n"
                "  - Scope: between @Mikka and the hero\n"
                "  - Effect: я закрываю стол, иду с героем как спутница и помню оплату.\n\n"
                "## Inventory",
            )
        text = text.replace("- 3 золотые монеты;", "- 3 @Gold coin;")
        text = text.replace("- 10 серебряных монет;", "- 10 @Silver coin;")
        text = text.replace("- 60 медных монет;", "- 60 @Copper coin;")
    if relative.endswith("/npc/@Sable Vey/SableVeyMind.md") and "## Merchant" not in text:
        text = text.replace(
            "## Inventory",
            "## Merchant\n\n"
            "Я продаю доступ, тишину, хранение, сведения и временное укрытие.\n\n"
            "Мои цены:\n\n"
            "- вход без поручителя - 5 @Silver coin;\n"
            "- тихий торговый жетон на один день - 1 @Gold coin;\n"
            "- сверка долга или имени по @Red ledger - 2 @Gold coin;\n"
            "- знакомство с продавцом рынка - 5 @Silver coin;\n"
            "- безопасное хранение маленького предмета на одну ночь - 3 @Silver coin;\n"
            "- временное укрытие под рынком на одну ночь - 1 @Gold coin.\n\n"
            "Я помню, кто платил, чем платил, за какую услугу, когда право "
            "истекает и кто пытался пройти повторно без оплаты.\n\n"
            "## Materializes\n\n"
            "- Когда герой платит за тихий торговый жетон:\n"
            "  - Entity: @Quiet trading token\n"
            "  - Type: item/access-state\n"
            "  - Scope: hero inventory and @Thief's market\n"
            "  - Effect: герой может торговать в @Thief's market до конца текущего дня.\n"
            "- Когда герой платит за безопасное хранение:\n"
            "  - Entity: @Locked market box\n"
            "  - Type: container/service\n"
            "  - Scope: under @Sable Vey's control\n"
            "  - Effect: я помню, какой предмет принят на хранение и до какого срока.\n"
            "- Когда герой платит за временное укрытие:\n"
            "  - Entity: @Back room under Thief's market\n"
            "  - Type: location/shelter\n"
            "  - Scope: inside @Thief's market\n"
            "  - Effect: у героя есть оплаченный доступ к укрытию на одну ночь.\n\n"
            "## Inventory",
        )
    return text


def write_text(path: Path, text: str, dry_run: bool) -> None:
    if dry_run:
        print(f"would write: {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n", encoding="utf-8", newline="\n")
    print(f"wrote: {path}")


def generate(vault: Path, force: bool, dry_run: bool) -> int:
    written = 0
    skipped = 0
    all_files = {**DEMO_FILES, **EXTRA_DEMO_FILES}
    for relative, text in all_files.items():
        path = vault / relative
        if path.exists() and not force:
            print(f"skip existing: {path}")
            skipped += 1
            continue
        write_text(path, patch_demo_text(relative, text), dry_run)
        written += 1
    print(f"written: {written}")
    print(f"skipped: {skipped}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate the Greenhaven demo Obsidian vault.")
    parser.add_argument(
        "--vault-root",
        default=str(default_vault_root(__file__)),
        help="Path to the GreenhavenWorld vault root.",
    )
    parser.add_argument("--force", action="store_true", help="Overwrite existing demo notes.")
    parser.add_argument("--dry-run", action="store_true", help="Print planned writes only.")
    args = parser.parse_args(argv)
    return generate(Path(args.vault_root).resolve(), force=args.force, dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
