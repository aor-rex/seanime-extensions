/// <reference path="app.d.ts" />
/// <reference path="core.d.ts" />

declare namespace $ui {
    /**
     * Registers the plugin as UI plugin.
     * @param fn - The setup function for the plugin.
     */
    function register(fn: (ctx: Context) => void): void

    interface Context {
        /**
         * Creates a new state object with an initial value.
         */
        state<T>(initialValue?: T): State<T>

        /**
         * Sets an interval to execute a function repeatedly.
         * @returns A function to cancel the interval
         */
        setInterval(fn: () => void, delay: number): () => void

        /**
         * Registers an event handler for the plugin.
         * @returns A function to unregister the handler.
         */
        registerEventHandler(eventName: string, handler: (event: any) => void): () => void

        /**
         * Registers an event handler for the plugin.
         * @returns The event handler id.
         */
        eventHandler(uniqueKey: string, handler: (event: any) => void): string

        /**
         * Creates a new tray icon.
         */
        newTray(options: TrayOptions): Tray

        /**
         * Show a toast notification.
         */
        toast: {
            success(message: string): void
            error(message: string): void
            info(message: string): void
            warning(message: string): void
        }
    }

    interface State<T> {
        /** The current value */
        value: T

        /** Gets the current value */
        get(): T

        /** Sets a new value */
        set(value: T | ((prev: T) => T)): void
    }

    interface TrayOptions {
        /** URL of the tray icon */
        iconUrl: string
        /** Whether the tray has content */
        withContent: boolean
        /** Width of the tray */
        width?: string
        /** Minimum height of the tray */
        minHeight?: string
    }

    interface Tray {
        /** UI components for building tray content */
        div: DivComponentFunction
        flex: FlexComponentFunction
        stack: StackComponentFunction
        text: TextComponentFunction
        button: ButtonComponentFunction
        anchor: AnchorComponentFunction
        input: InputComponentFunction
        select: SelectComponentFunction
        checkbox: CheckboxComponentFunction
        radioGroup: RadioGroupComponentFunction
        switch: SwitchComponentFunction
        css: CSSComponentFunction
        tooltip: TooltipComponentFunction
        modal: ModalComponentFunction
        dropdownMenu: DropdownMenuComponentFunction
        dropdownMenuItem: DropdownMenuItemComponentFunction
        dropdownMenuSeparator: DropdownMenuSeparatorComponentFunction
        dropdownMenuLabel: DropdownMenuLabelComponentFunction
        popover: PopoverComponentFunction
        a: AComponentFunction
        p: PComponentFunction
        alert: AlertComponentFunction
        tabs: TabsComponentFunction
        tabsList: TabsListComponentFunction
        tabsTrigger: TabsTriggerComponentFunction
        tabsContent: TabsContentComponentFunction
        badge: BadgeComponentFunction
        span: SpanComponentFunction
        img: ImgComponentFunction

        /** Registers the render function for the tray content */
        render(fn: () => void): void

        /** Schedules a re-render of the tray content */
        update(): void

        /** Opens the tray */
        open(): void

        /** Closes the tray */
        close(): void

        /**
         * Sets the badge shown next to the tray icon. A number of 0 hides it.
         * @param props - { number: count, intent?: "info" | "success" | "alert" | "gray" | "empty" }
         */
        updateBadge(props: { number: number, intent?: "info" | "success" | "alert" | "gray" | "empty" }): void

        /** Registers a callback invoked when the tray is opened. */
        onOpen(fn: () => void): void

        /** Registers a callback invoked when the tray is closed. */
        onClose(fn: () => void): void
    }

    type ComponentProps = {
        style?: Record<string, string>,
        className?: string,
    }

    type DivComponentFunction = {
        (props: { items: any[] } & ComponentProps): void
        (items: any[], props?: ComponentProps): void
    }
    type FlexComponentFunction = {
        (props: { items: any[], gap?: number, direction?: "row" | "column" } & ComponentProps): void
        (items: any[], props?: { gap?: number, direction?: "row" | "column" } & ComponentProps): void
    }
    type StackComponentFunction = {
        (props: { items: any[], gap?: number } & ComponentProps): void
        (items: any[], props?: { gap?: number } & ComponentProps): void
    }
    type TextComponentFunction = {
        (props: { text: string } & ComponentProps): void
        (text: string, props?: ComponentProps): void
    }
    type ButtonComponentFunction = {
        (props: {
            label?: string,
            onClick?: string,
            intent?: Intent,
            disabled?: boolean,
            loading?: boolean,
            size?: "xs" | "sm" | "md" | "lg"
        } & ComponentProps): void
        (label: string,
            props?: { onClick?: string, intent?: Intent, disabled?: boolean, loading?: boolean, size?: "xs" | "sm" | "md" | "lg" } & ComponentProps,
        ): void
    }
    type AnchorComponentFunction = {
        (props: {
            text: string,
            href: string,
            target?: string,
            onClick?: string
        } & ComponentProps): void
        (text: string,
            props: { href: string, target?: string, onClick?: string } & ComponentProps,
        ): void
    }
    type InputComponentFunction = {
        (props: { label?: string, placeholder?: string, textarea?: boolean, onSelect?: string } & FieldComponentProps): void
        (label: string, props?: { placeholder?: string, textarea?: boolean, onSelect?: string } & FieldComponentProps): void
    }
    type SelectComponentFunction = {
        (props: { label: string, placeholder?: string, options: { label: string, value: string }[] } & FieldComponentProps): void
        (label: string, options: { placeholder?: string, value?: string, options: { label: string, value: string }[] } & FieldComponentProps): void
    }
    type CheckboxComponentFunction = {
        (props: { label: string } & FieldComponentProps<boolean>): void
        (label: string, props?: FieldComponentProps<boolean>): void
    }
    type RadioGroupComponentFunction = {
        (props: { label: string, options: { label: string, value: string }[] } & FieldComponentProps): void
        (label: string, options: { value?: string, options: { label: string, value: string }[] } & FieldComponentProps): void
    }
    type SwitchComponentFunction = {
        (props: { label: string, side?: "left" | "right" } & FieldComponentProps<boolean>): void
        (label: string, props?: { side?: "left" | "right" } & FieldComponentProps<boolean>): void
    }
    type TooltipComponentFunction = {
        (props: { text: string, item: any, side?: "top" | "right" | "bottom" | "left", sideOffset?: number }): void
        (item: any, props: { text: string, side?: "top" | "right" | "bottom" | "left", sideOffset?: number }): void
    }
    type ModalComponentFunction = {
        (props: {
            trigger: any,
            title?: string,
            description?: string,
            items?: any[],
            footer?: any[],
            open?: boolean,
            onOpenChange?: string
        } & ComponentProps): void
    }
    type DropdownMenuComponentFunction = {
        (props: {
            trigger: any,
            items: any[]
        } & ComponentProps): void
    }
    type DropdownMenuItemComponentFunction = {
        (props: {
            item: any,
            onClick?: string,
            disabled?: boolean
        } & ComponentProps): void
        (item: any, props?: { onClick?: string, disabled?: boolean } & ComponentProps): void
    }
    type DropdownMenuSeparatorComponentFunction = {
        (props?: ComponentProps): void
    }
    type DropdownMenuLabelComponentFunction = {
        (props: { label: string } & ComponentProps): void
        (label: string, props?: ComponentProps): void
    }
    type PopoverComponentFunction = {
        (props: {
            trigger: any,
            items: any[]
        } & ComponentProps): void
    }
    type AComponentFunction = {
        (props: {
            href: string,
            items: any[],
            target?: string,
            onClick?: string
        } & ComponentProps): void
        (items: any[], props: { href: string, target?: string, onClick?: string } & ComponentProps): void
    }
    type PComponentFunction = {
        (props: { items: any[] } & ComponentProps): void
        (items: any[], props?: ComponentProps): void
    }
    type AlertComponentFunction = {
        (props: {
            title?: string,
            description?: string,
            intent?: "info" | "success" | "warning" | "alert"
        } & ComponentProps): void
    }
    type TabsComponentFunction = {
        (props: {
            defaultValue?: string,
            items: any[]
        } & ComponentProps): void
        (items: any[], props?: { defaultValue?: string } & ComponentProps): void
    }
    type TabsListComponentFunction = {
        (props: { items: any[] } & ComponentProps): void
        (items: any[], props?: ComponentProps): void
    }
    type TabsTriggerComponentFunction = {
        (item: any, props: { value: string }): void
        (props: {
            item: any,
            value: string
        }): void
    }
    type TabsContentComponentFunction = {
        (props: {
            value: string,
            items: any[]
        } & ComponentProps): void
        (items: any[], props: { value: string } & ComponentProps): void
    }
    type BadgeComponentFunction = {
        (props: {
            text: string,
            intent?: "gray" | "primary" | "success" | "warning" | "alert" | "info" | "blue",
            size?: "sm" | "md" | "lg" | "xl"
        } & ComponentProps): void
        (text: string, props?: {
            intent?: "gray" | "primary" | "success" | "warning" | "alert" | "info" | "blue",
            size?: "sm" | "md" | "lg" | "xl"
        } & ComponentProps): void
    }
    type SpanComponentFunction = {
        (props: { text: string, items?: any[] } & ComponentProps): void
        (text: string, props?: { items?: any[] } & ComponentProps): void
    }
    type ImgComponentFunction = {
        (props: { src: string, alt?: string, width?: string, height?: string } & ComponentProps): void
        (src: string, props?: { alt?: string, width?: string, height?: string } & ComponentProps): void
    }

    type FieldComponentProps<V = string> = {
        fieldRef?: FieldRef<V>,
        value?: V,
        onChange?: string,
        disabled?: boolean,
        size?: "sm" | "md" | "lg",

    } & ComponentProps

    type Intent = "primary" | "success" | "warning" | "danger" | "info" | "gray" | "alert" | "primary-subtle" | "success-subtle" | "warning-subtle" | "danger-subtle" | "info-subtle" | "gray-subtle" | "alert-subtle"

    interface FieldRef<T> {
        /** The current value of the field */
        current: T

        /** Sets the value of the field */
        setValue(value: T): void

        /** Sets the callback to be called when the value changes */
        onValueChange(callback: (value: T) => void): void
    }
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

    /**
     * Update a media list entry. Status and score are optional; pass undefined to leave them unchanged.
     */
    function updateEntry(
        mediaId: number,
        status: $app.AL_MediaListStatus | undefined,
        scoreRaw: number | undefined,
        progress: number | undefined,
        startedAt: $app.AL_FuzzyDateInput | undefined,
        completedAt: $app.AL_FuzzyDateInput | undefined,
    ): void

    /**
     * Delete a media list entry.
     */
    function deleteEntry(mediaId: number): void
}

declare namespace $storage {
    function get(key: string): any
    function set(key: string, value: any): void
    function remove(key: string): void
}
