/**
 * Maps full language names to ISO 639-1 language codes.
 * @param language The full name of the language (e.g., 'Finnish', 'Spanish').
 * @returns The ISO 639-1 language code (e.g., 'fi', 'es'). Defaults to 'en'.
 */
export function getLanguageCode(language: string): string {
    const normalizedLanguage = language.toLowerCase().trim();

    const languageMap: { [key: string]: string } = {
        'english': 'en',
        'finnish': 'fi',
        'spanish': 'es',
        'french': 'fr',
        'german': 'de',
        'italian': 'it',
        'portuguese': 'pt',
        'russian': 'ru',
        'japanese': 'ja',
        'chinese': 'zh',
        'korean': 'ko',
        'dutch': 'nl',
        'swedish': 'sv',
        'norwegian': 'no',
        'danish': 'da',
        'polish': 'pl',
        'turkish': 'tr',
        'hindi': 'hi',
        'arabic': 'ar',
        'thai': 'th',
        'vietnamese': 'vi',
        'indonesian': 'id'
    };

    return languageMap[normalizedLanguage] || 'en';
}
