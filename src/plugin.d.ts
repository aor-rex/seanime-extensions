/// <reference path="app.d.ts" />
/// <reference path="core.d.ts" />

declare namespace $ui {
    /**
     * Registers the plugin as UI plugin.
     * @param fn - The setup function for the plugin.
     */
    function register(fn: (ctx: Context) => void): void

    interface Context {}
}

declare namespace $anilist {
    /**
     * Get anime by ID (resolves custom-source ids through the source extension).
     */
    function getAnime(id: number): $app.AL_BaseAnime

    /**
     * Get the user's anime collection.
     */
    function getAnimeCollection(cached?: boolean): $app.AL_AnimeCollection
}

declare namespace $storage {
    function get(key: string): string
    function set(key: string, value: string): void
    function remove(key: string): void
}
