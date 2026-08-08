declare type AnimeProviderSmartSearchFilter = "batch" | "episodeNumber" | "resolution" | "query" | "bestReleases"

declare type AnimeProviderType = "main" | "special"

declare interface AnimeProviderSettings {
    // Indicates whether the extension supports smart search.
    canSmartSearch: boolean
    // Filters that can be used in smart search.
    smartSearchFilters: AnimeProviderSmartSearchFilter[]
    // Indicates whether the extension supports adult content.
    supportsAdult: boolean
    // Type of the provider.
    type: AnimeProviderType
}

// Media object passed to 'search' and 'smartSearch' methods.
declare interface Media {
    // AniList ID of the media.
    id: number
    // MyAnimeList ID of the media.
    idMal?: number
    // e.g. "FINISHED", "RELEASING", "NOT_YET_RELEASED", "CANCELLED", "HIATUS"
    // This will be set to "NOT_YET_RELEASED" if the status is unknown.
    status?: string
    // e.g. "TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"
    // This will be set to "TV" if the format is unknown.
    format?: string
    // e.g. "Attack on Titan"
    englishTitle?: string
    // e.g. "Shingeki no Kyojin"
    romajiTitle?: string
    // TotalEpisodes is total number of episodes of the media.
    // This will be -1 if the total number of episodes is unknown / not applicable.
    episodeCount?: number
    // Absolute offset of the media's season.
    // This will be 0 if the media is not seasonal or the offset is unknown.
    absoluteSeasonOffset?: number
    // Season year of the media (e.g. 2010). Not part of the official docs but provided at runtime.
    seasonYear?: number
    // All alternative titles of the media.
    synonyms: string[]
    // Whether the media is NSFW.
    isAdult: boolean
    // Start date of the media.
    // This will be undefined if it has no start date.
    startDate?: FuzzyDate
}

declare interface FuzzyDate {
    year: number
    month?: number
    day?: number
}

declare interface AnimeSearchOptions {
    // The media object.
    media: Media
    // The user search query.
    query: string
}

declare interface AnimeSmartSearchOptions {
    // The media object.
    media: Media
    // The user search query.
    // This will be empty if your extension does not support custom queries.
    query: string
    // Indicates whether the user wants to search for batch torrents.
    // This will be false if your extension does not support batch torrents.
    batch: boolean
    // The episode number the user wants to search for.
    // This will be 0 if your extension does not support episode number filtering.
    episodeNumber: number
    // The resolution the user wants to search for.
    // This will be empty if your extension does not support resolution filtering.
    resolution: string
    // AniDB Anime ID of the media.
    anidbAID: number
    // AniDB Episode ID of the media.
    anidbEID: number
    // Indicates whether the user wants to search for the best releases.
    // This will be false if your extension does not support filtering by best releases.
    bestReleases: boolean
}

declare interface AnimeTorrent {
    name: string
    // Date of the torrent.
    // The date should have RFC3339 format. e.g. "2006-01-02T15:04:05Z07:00"
    date: string
    // Size of the torrent in bytes.
    size: number
    // Formatted size of the torrent. e.g. "1.2 GB"
    // Leave this empty if you want Seanime to format the size.
    formattedSize: string
    // Number of seeders of the torrent.
    seeders: number
    // Number of leechers of the torrent.
    leechers: number
    // Number of downloads of the torrent.
    downloadCount: number
    // Link to the torrent page.
    link: string
    // Download URL of the torrent.
    // Leave this empty if you cannot provide a direct download URL.
    downloadUrl?: string
    // Magnet link of the torrent.
    // Set this to null if you cannot provide a magnet link without scraping.
    magnetLink?: string | null
    // Info hash of the torrent.
    // Set this to null if you cannot provide an info hash without scraping.
    infoHash?: string | null
    // The resolution of the torrent.
    // Leave this empty if you want Seanime to parse the resolution from the name.
    resolution?: string
    // Set this to true if you can confirm that the torrent is a batch.
    // Else, Seanime will parse the torrent name to determine if it's a batch.
    isBatch?: boolean
    // Episode number of the torrent.
    // Return -1 if unknown / unable to determine and Seanime will parse the torrent name.
    episodeNumber: number
    // Release group of the torrent.
    // Leave this empty if you want Seanime to parse the release group from the name.
    releaseGroup?: string
    // Set this to true if you can confirm that the torrent is the best release.
    isBestRelease: boolean
    // Set this to true if you can confirm that the torrent matches the anime the user is searching for.
    // e.g. If the torrent was found using the AniDB anime or episode ID
    confirmed: boolean
}
