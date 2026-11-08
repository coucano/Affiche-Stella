# Affiches Stella

Page qui montre les affiches de cinéma disponibles, avec l'affiche de chaque film.

- La liste vient du Google Sheet du cinéma (lu chaque nuit).
- Les affiches, la popularité et les notes viennent de [TMDB](https://www.themoviedb.org), en version française quand elle existe.
- La page est publiée avec GitHub Pages.

## Mise à jour

Automatique chaque nuit. Pour lancer tout de suite : onglet **Actions** → « Générer la page des affiches » → **Run workflow**.

## Corriger une affiche

Deux possibilités :

1. Dans le Google Sheet, ajouter une colonne nommée **Affiche** et y coller le lien de la bonne image sur la ligne du film.
2. Ou modifier `data/overrides.json` ici :

```json
{
  "Yiyi": "https://exemple.com/affiche-yiyi.jpg"
}
```

## Réglages

- Secret `TMDB_KEY` (Settings → Secrets and variables → Actions) : la clé d'API TMDB.
- `data/posters.json` : affiches déjà trouvées, mises à jour par le programme. Supprimer une ligne force une nouvelle recherche.
