" ca65 syntax: a translation of the ca65 VS Code extension's TextMate grammar
" (syntaxes/ca65.tmLanguage.json in this repo).
" The language server's semantic tokens colour symbols on top of this.
"
" Vim picks the last-defined item when several match at the same position, so
" the more specific rules come after the general ones.

if exists("b:current_syntax")
  finish
endif

" --- Numbers, operators, registers ---------------------------------------------
syn match ca65Number    "\v%(\$\x+|\%[01]+|<\d+)>"
syn match ca65Immediate "#"
syn match ca65Register  "\v,\s*\zs[xyXY]>"
syn match ca65Register  "\v\c<%(asl|lsr|rol|ror|inc|dec)\s+\zsa>"

" Flow-control mnemonics (the grammar leaves the other mnemonics as plain symbols)
syn case ignore
syn keyword ca65Flow jsr jmp bcc bcs beq bmi bne bpl bvc bvs rts rti brk
syn case match

" --- Directives ----------------------------------------------------------------
syn match ca65Directive "\v\.\h\w*"
" Directives that name something: the name gets its own colour
syn match ca65ProcDir   "\v\c\.%(proc|macro)>"   nextgroup=ca65ProcName   skipwhite
syn match ca65DefineDir "\v\c\.define>"          nextgroup=ca65DefineName skipwhite
syn match ca65StructDir "\v\c\.%(struct|union)>" nextgroup=ca65StructName skipwhite
syn match ca65EnumDir   "\v\c\.enum>"            nextgroup=ca65EnumName   skipwhite
syn match ca65ScopeDir  "\v\c\.scope>"           nextgroup=ca65ScopeName  skipwhite
syn match ca65ProcName   "\v%(\h\w*::)*\h\w*" contained
syn match ca65DefineName "\v%(\h\w*::)*\h\w*" contained
syn match ca65StructName "\v%(\h\w*::)*\h\w*" contained
syn match ca65EnumName   "\v%(\h\w*::)*\h\w*" contained
syn match ca65ScopeName  "\v%(\h\w*::)*\h\w*" contained

" --- Assignments: NAME = expr (constant), NAME := expr (variable) ---------------
syn match ca65ConstAssign "\v%(^\s*|%(::)@<=)\zs\h\w*\ze\s*\=" nextgroup=ca65Assign skipwhite
syn match ca65VarAssign   "\v%(^\s*|%(::)@<=)\zs\h\w*\ze\s*:\=" nextgroup=ca65Assign skipwhite
syn match ca65Assign      "\v:?\=" contained

" --- Labels --------------------------------------------------------------------
syn match ca65Label      "\v<\h\w*\ze:%(:)@!"
syn match ca65CheapLabel "\v\@\w*\ze:"
" Labels on storage (.res, or a ; ZEROPAGE/BSS/DATA comment) are variables;
" labels on data (.byte, .word, ...) are constants
syn match ca65VarLabel   "\v<\h\w*\ze:\s*%(\.res>|;\s*%(ZEROPAGE|ZP|DIRECTPAGE|DP|BSS|DATA)>)"
syn match ca65DataLabel  "\v<\h\w*\ze:\s*%(\.%(byte|byt|word|dword|addr|faraddr|asciiz|literal|incbin)>|;\s*RODATA>)"
" Anonymous labels: a lone ':' at the start of a line, and :- :+ :< :> references
syn match ca65AnonLabel  "\v^\s*\zs:\ze%(\s|$|;)"
syn match ca65AnonRef    "\v:[-+<>]+"

" Scope prefix: the Scope in Scope::name
syn match ca65Namespace  "\v<\h\w*\ze::"

" --- Strings -------------------------------------------------------------------
syn match  ca65Escape contained "\v\\."
syn region ca65String start=+"+ skip=+\\.+ end=+"+ contains=ca65Escape oneline
syn region ca65String start=+'+ skip=+\\.+ end=+'+ contains=ca65Escape oneline

" --- Comments ------------------------------------------------------------------
" {symbol} and {@link symbol} references, in any comment
syn match ca65DocLink contained "\v\{%(\@link\s+)?%(::)?\h\w*%(::\h\w*)*\}" contains=ca65DocLinkTag,ca65DocLinkName
syn match ca65DocLinkName contained "\v%(::)?\h\w*%(::\h\w*)*"
syn match ca65DocLinkTag  contained "\v\@link>"
" @tags at the start of a doc comment line (after the * gutter)
syn match ca65DocTag contained "\v\c%(^\s*%(\*\s*)?|\/\*\*\s*)\zs\@%(param|arg|argument|input|in|output|out|see|modifies|uses|returns?|throws|deprecated|since|author|note|warning|example|todo|brief|details)>" nextgroup=ca65DocParam skipwhite
" The name after @param/@input/@output...
syn match ca65DocParam contained "\v[^ \t*()]+"
" @clobbers/@preserves take a list, with or without commas: @preserves a, x, y or
" @clobbers a x. Every item is coloured; the list ends at " - description", ':' or '('
" (as in the TextMate grammar).
syn match ca65DocTag contained "\v\c%(^\s*%(\*\s*)?|\/\*\*\s*)\zs\@%(clobbers?|preserves?)>" nextgroup=ca65DocList skipwhite
syn match ca65DocList contained transparent "\v[^ \t,:*()]+%(%(\s*,\s*|\s+)%([-–—])@![^ \t,:*()]+)*" contains=ca65DocListItem
syn match ca65DocListItem contained "\v[^ \t,:*()]+"

syn match  ca65Comment      ";.*$" contains=ca65DocLink
syn region ca65BlockComment start="/\*" end="\*/" contains=ca65DocLink
syn region ca65DocComment   start="/\*\*\%(/\)\@!" end="\*/" contains=ca65DocTag,ca65DocLink

" --- Colours (TextMate scope -> Vim group) -------------------------------------
hi def link ca65Comment      Comment
hi def link ca65BlockComment Comment
hi def link ca65DocComment   Comment
hi def link ca65DocTag       SpecialComment
hi def link ca65DocParam     Identifier
hi def link ca65DocListItem  ca65DocParam
hi def link ca65DocLink      Comment
hi def link ca65DocLinkName  Underlined
hi def link ca65DocLinkTag   SpecialComment
hi def link ca65String       String
hi def link ca65Escape       SpecialChar
hi def link ca65Namespace    Type
hi def link ca65Label        Function
hi def link ca65CheapLabel   Function
hi def link ca65AnonLabel    Label
hi def link ca65AnonRef      Identifier
hi def link ca65VarLabel     Identifier
hi def link ca65DataLabel    Constant
hi def link ca65VarAssign    Identifier
hi def link ca65ConstAssign  Constant
hi def link ca65Assign       Operator
hi def link ca65Directive    PreProc
hi def link ca65ProcDir      PreProc
hi def link ca65DefineDir    PreProc
hi def link ca65StructDir    PreProc
hi def link ca65EnumDir      PreProc
hi def link ca65ScopeDir     PreProc
hi def link ca65ProcName     Function
hi def link ca65DefineName   Constant
hi def link ca65StructName   Structure
hi def link ca65EnumName     Type
hi def link ca65ScopeName    Type
hi def link ca65Flow         Statement
hi def link ca65Immediate    Operator
hi def link ca65Number       Number
hi def link ca65Register     Special

" Parse from the top so a /* */ comment that started above the screen is still
" a comment (source files are small, so this stays fast)
syn sync fromstart

let b:current_syntax = "ca65"
