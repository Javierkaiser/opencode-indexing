// Ported from Kilo Code (github.com/Kilo-Org/kilocode, MIT License). Copyright (c) 2026 Kilo Code.
//
// Tree-sitter S-expression queries, one per supported language. These are
// byte-for-byte copies of Kilo Code's query strings, consolidated into a
// single module. Do not reformat: whitespace and comment placement inside
// the queries are semantically meaningful to tree-sitter.

export const typescriptQuery = `
(function_signature
  name: (identifier) @name.definition.function) @definition.function

(method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(module
  name: (identifier) @name.definition.module) @definition.module

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(call_expression
  function: (identifier) @func_name
  arguments: (arguments
    (string) @name
    [(arrow_function) (function_expression)]) @definition.test)
  (#match? @func_name "^(describe|test|it)$")

(assignment_expression
  left: (member_expression
    object: (identifier) @obj
    property: (property_identifier) @prop)
  right: [(arrow_function) (function_expression)]) @definition.test
  (#eq? @obj "exports")
  (#eq? @prop "test")
(arrow_function) @definition.lambda

; Switch statements and case clauses
(switch_statement) @definition.switch

; Individual case clauses with their blocks
(switch_case) @definition.case

; Default clause
(switch_default) @definition.default

; Enum declarations
(enum_declaration
  name: (identifier) @name.definition.enum) @definition.enum

; Decorator definitions with decorated class
(export_statement
  decorator: (decorator
    (call_expression
      function: (identifier) @name.definition.decorator))
  declaration: (class_declaration
    name: (type_identifier) @name.definition.decorated_class)) @definition.decorated_class

; Explicitly capture class name in decorated class
(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

; Namespace declarations
(internal_module
  name: (identifier) @name.definition.namespace) @definition.namespace

; Interface declarations with generic type parameters and constraints
(interface_declaration
  name: (type_identifier) @name.definition.interface
  type_parameters: (type_parameters)?) @definition.interface

; Type alias declarations with generic type parameters and constraints
(type_alias_declaration
  name: (type_identifier) @name.definition.type
  type_parameters: (type_parameters)?) @definition.type

; Utility Types
(type_alias_declaration
  name: (type_identifier) @name.definition.utility_type) @definition.utility_type

; Class Members and Properties
(public_field_definition
  name: (property_identifier) @name.definition.property) @definition.property

; Constructor
(method_definition
  name: (property_identifier) @name.definition.constructor
  (#eq? @name.definition.constructor "constructor")) @definition.constructor

; Getter/Setter Methods
(method_definition
  name: (property_identifier) @name.definition.accessor) @definition.accessor

; Async Functions
(function_declaration
  name: (identifier) @name.definition.async_function) @definition.async_function

; Async Arrow Functions
(variable_declaration
  (variable_declarator
    name: (identifier) @name.definition.async_arrow
    value: (arrow_function))) @definition.async_arrow
`

export const tsxQuery = `${typescriptQuery}

; Function Components - Both function declarations and arrow functions
(function_declaration
  name: (identifier) @name) @definition.component

; Arrow Function Components
(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function))) @definition.component

; Export Statement Components
(export_statement
  (variable_declaration
    (variable_declarator
      name: (identifier) @name
      value: (arrow_function)))) @definition.component

; Class Components
(class_declaration
  name: (type_identifier) @name) @definition.class_component

; Interface Declarations
(interface_declaration
  name: (type_identifier) @name) @definition.interface

; Type Alias Declarations
(type_alias_declaration
  name: (type_identifier) @name) @definition.type

; HOC Components
(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression
      function: (identifier)))) @definition.component

; JSX Component Usage - Capture all components in JSX
(jsx_element
  open_tag: (jsx_opening_element
    name: [(identifier) @component (member_expression) @component])) @definition.jsx_element

; Self-closing JSX elements
(jsx_self_closing_element
  name: [(identifier) @component (member_expression) @component]) @definition.jsx_self_closing_element

; Capture all identifiers in JSX expressions that start with capital letters
(jsx_expression
  (identifier) @jsx_component) @definition.jsx_component

; Capture all member expressions in JSX
(member_expression
  object: (identifier) @object
  property: (property_identifier) @property) @definition.member_component

; Capture components in conditional expressions
(ternary_expression
  consequence: (parenthesized_expression
    (jsx_element
      open_tag: (jsx_opening_element
        name: (identifier) @component)))) @definition.conditional_component

(ternary_expression
  alternative: (jsx_self_closing_element
    name: (identifier) @component)) @definition.conditional_component

; Generic Components
(function_declaration
  name: (identifier) @name
  type_parameters: (type_parameters)) @definition.generic_component
`

export const javascriptQuery = `
(
  (comment)* @doc
  .
  (method_definition
    name: (property_identifier) @name) @definition.method
  (#not-eq? @name "constructor")
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.method)
)

(
  (comment)* @doc
  .
  [
    (class
      name: (_) @name)
    (class_declaration
      name: (_) @name)
  ] @definition.class
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.class)
)

(
  (comment)* @doc
  .
  [
    (function_declaration
      name: (identifier) @name)
    (generator_function_declaration
      name: (identifier) @name)
  ] @definition.function
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

(
  (comment)* @doc
  .
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: [(arrow_function) (function_expression)]) @definition.function)
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

(
  (comment)* @doc
  .
  (variable_declaration
    (variable_declarator
      name: (identifier) @name
      value: [(arrow_function) (function_expression)]) @definition.function)
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

; JSON object definitions
(object) @object.definition

; JSON object key-value pairs
(pair
  key: (string) @property.name.definition
  value: [
    (object) @object.value
    (array) @array.value
    (string) @string.value
    (number) @number.value
    (true) @boolean.value
    (false) @boolean.value
    (null) @null.value
  ]
) @property.definition

; JSON array definitions
(array) @array.definition
; Decorated method definitions
(
  [
    (method_definition
      decorator: (decorator)
      name: (property_identifier) @name) @definition.method
    (method_definition
      decorator: (decorator
        (call_expression
          function: (identifier) @decorator_name))
      name: (property_identifier) @name) @definition.method
  ]
  (#not-eq? @name "constructor")
)

; Decorated class definitions
(
  [
    (class
      decorator: (decorator)
      name: (_) @name) @definition.class
    (class_declaration
      decorator: (decorator)
      name: (_) @name) @definition.class
  ]
)

; Capture method names in decorated classes
(
  (class_declaration
    decorator: (decorator)
    body: (class_body
      (method_definition
        name: (property_identifier) @name) @definition.method))
  (#not-eq? @name "constructor")
)
`

export const pythonQuery = `
; Class definitions (including decorated)
(class_definition
  name: (identifier) @name.definition.class) @definition.class

(decorated_definition
  definition: (class_definition
    name: (identifier) @name.definition.class)) @definition.class

; Function and method definitions (including async and decorated)
(function_definition
  name: (identifier) @name.definition.function) @definition.function

(decorated_definition
  definition: (function_definition
    name: (identifier) @name.definition.function)) @definition.function

; Lambda expressions
(expression_statement
  (assignment
    left: (identifier) @name.definition.lambda
    right: (parenthesized_expression
      (lambda)))) @definition.lambda

; Generator functions (functions containing yield)
(function_definition
  name: (identifier) @name.definition.generator
  body: (block
    (expression_statement
      (yield)))) @definition.generator

; Comprehensions
(expression_statement
  (assignment
    left: (identifier) @name.definition.comprehension
    right: [
      (list_comprehension)
      (dictionary_comprehension)
      (set_comprehension)
    ])) @definition.comprehension

; With statements
(with_statement) @definition.with_statement

; Try statements
(try_statement) @definition.try_statement

; Import statements
(import_from_statement) @definition.import
(import_statement) @definition.import

; Global/Nonlocal statements
(function_definition
  body: (block
    [(global_statement) (nonlocal_statement)])) @definition.scope

; Match case statements
(function_definition
  body: (block
    (match_statement))) @definition.match_case

; Type annotations
(typed_parameter
  type: (type)) @definition.type_annotation

(expression_statement
  (assignment
    left: (identifier) @name.definition.type
    type: (type))) @definition.type_annotation
`

export const rustQuery = `
; Function definitions (all types)
(function_item
    name: (identifier) @name.definition.function) @definition.function

; Struct definitions (all types - standard, tuple, unit)
(struct_item
    name: (type_identifier) @name.definition.struct) @definition.struct

; Enum definitions with variants
(enum_item
    name: (type_identifier) @name.definition.enum) @definition.enum

; Trait definitions
(trait_item
    name: (type_identifier) @name.definition.trait) @definition.trait

; Impl blocks (inherent implementation)
(impl_item
    type: (type_identifier) @name.definition.impl) @definition.impl

; Trait implementations
(impl_item
    trait: (type_identifier) @name.definition.impl_trait
    type: (type_identifier) @name.definition.impl_for) @definition.impl_trait

; Module definitions
(mod_item
    name: (identifier) @name.definition.module) @definition.module

; Macro definitions
(macro_definition
    name: (identifier) @name.definition.macro) @definition.macro

; Attribute macros (for #[derive(...)] etc.)
(attribute_item
    (attribute) @name.definition.attribute) @definition.attribute

; Type aliases
(type_item
    name: (type_identifier) @name.definition.type_alias) @definition.type_alias

; Constants
(const_item
    name: (identifier) @name.definition.constant) @definition.constant

; Static items
(static_item
    name: (identifier) @name.definition.static) @definition.static

; Methods inside impl blocks
(impl_item
    body: (declaration_list
        (function_item
            name: (identifier) @name.definition.method))) @definition.method_container

; Use declarations
(use_declaration) @definition.use_declaration

; Lifetime definitions
(lifetime
    "'" @punctuation.lifetime
    (identifier) @name.definition.lifetime) @definition.lifetime

; Where clauses
(where_clause
    (where_predicate)*) @definition.where_clause

; Match expressions
(match_expression
    value: (_) @match.value
    body: (match_block)) @definition.match

; Unsafe blocks
(unsafe_block) @definition.unsafe_block
`

export const goQuery = `
; Function declarations - capture the entire declaration
(function_declaration) @name.definition.function

; Method declarations - capture the entire declaration
(method_declaration) @name.definition.method

; Type declarations (interfaces, structs, type aliases) - capture the entire declaration
(type_declaration) @name.definition.type

; Variable declarations - capture the entire declaration
(var_declaration) @name.definition.var

; Constant declarations - capture the entire declaration  
(const_declaration) @name.definition.const

; Package clause
(package_clause) @name.definition.package

; Import declarations - capture the entire import block
(import_declaration) @name.definition.import
`

export const cppQuery = `
; Basic declarations
(struct_specifier
  name: (type_identifier) @name.definition.class) @definition.class

(union_specifier
  name: (type_identifier) @name.definition.class) @definition.class

; Function declarations (prototypes)
(declaration
  type: (_)
  declarator: (function_declarator
    declarator: (identifier) @name.definition.function)) @definition.function

; Function definitions (with body)
(function_definition
  type: (_)
  declarator: (function_declarator
    declarator: (identifier) @name.definition.function)) @definition.function

(function_definition
  declarator: (function_declarator
    declarator: (field_identifier) @name.definition.method)) @definition.method

(type_definition
  type: (_)
  declarator: (type_identifier) @name.definition.type) @definition.type

(class_specifier
  name: (type_identifier) @name.definition.class) @definition.class

; Enum declarations
(enum_specifier
  name: (type_identifier) @name.definition.enum) @definition.enum

; Namespace definitions
(namespace_definition
  name: (namespace_identifier) @name.definition.namespace) @definition.namespace

(namespace_definition
  body: (declaration_list
    (namespace_definition
      name: (namespace_identifier) @name.definition.namespace))) @definition.namespace

; Template declarations
(template_declaration
  parameters: (template_parameter_list)
  (class_specifier
    name: (type_identifier) @name.definition.template.class)) @definition.template

; Macro definitions
(preproc_function_def
  name: (identifier) @name.definition.macro) @definition.macro

; Variable declarations with initialization
(declaration
  type: (_)
  declarator: (init_declarator
    declarator: (identifier) @name.definition.variable)) @definition.variable

; Constructor declarations
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name.definition.constructor)) @definition.constructor

; Destructor declarations
(function_definition
  declarator: (function_declarator
    declarator: (destructor_name) @name.definition.destructor)) @definition.destructor

; Operator overloads
(function_definition
  declarator: (function_declarator
    declarator: (operator_name) @name.definition.operator)) @definition.operator

; Friend declarations
(friend_declaration) @definition.friend

; Using declarations
(using_declaration) @definition.using
`

export const cQuery = `
; Function definitions and declarations
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name.definition.function))

(declaration
  type: (_)?
  declarator: (function_declarator
    declarator: (identifier) @name.definition.function
    parameters: (parameter_list)?)?) @definition.function

(function_declarator
  declarator: (identifier) @name.definition.function
  parameters: (parameter_list)?) @definition.function

; Struct definitions
(struct_specifier
  name: (type_identifier) @name.definition.struct) @definition.struct

; Union definitions
(union_specifier
  name: (type_identifier) @name.definition.union) @definition.union

; Enum definitions
(enum_specifier
  name: (type_identifier) @name.definition.enum) @definition.enum

; Typedef declarations
(type_definition
  declarator: (type_identifier) @name.definition.type) @definition.type

; Global variables
(declaration
  (storage_class_specifier)?
  type: (_)
  declarator: (identifier) @name.definition.variable) @definition.variable

(declaration
  (storage_class_specifier)?
  type: (_)
  declarator: (init_declarator
    declarator: (identifier) @name.definition.variable)) @definition.variable

; Object-like macros
(preproc_def
  name: (identifier) @name.definition.macro) @definition.macro

; Function-like macros
(preproc_function_def
  name: (identifier) @name.definition.macro) @definition.macro
`

export const csharpQuery = `
; Using directives
(using_directive) @definition.using
 
; Namespace declarations (including file-scoped)
; Support both simple names (TestNamespace) and qualified names (My.Company.Module)
(namespace_declaration
  name: (qualified_name) @name) @definition.namespace
(namespace_declaration
  name: (identifier) @name) @definition.namespace
(file_scoped_namespace_declaration
  name: (qualified_name) @name) @definition.namespace
(file_scoped_namespace_declaration
  name: (identifier) @name) @definition.namespace
 
; Class declarations (including generic, static, abstract, partial, nested)
(class_declaration
  name: (identifier) @name) @definition.class
 
; Interface declarations
(interface_declaration
  name: (identifier) @name) @definition.interface
 
; Struct declarations
(struct_declaration
  name: (identifier) @name) @definition.struct
 
; Enum declarations
(enum_declaration
  name: (identifier) @name) @definition.enum
 
; Record declarations
(record_declaration
  name: (identifier) @name) @definition.record
 
; Method declarations (including async, static, generic)
(method_declaration
  name: (identifier) @name) @definition.method
 
; Property declarations
(property_declaration
  name: (identifier) @name) @definition.property
 
; Event declarations
(event_declaration
  name: (identifier) @name) @definition.event
 
; Delegate declarations
(delegate_declaration
  name: (identifier) @name) @definition.delegate
 
; Attribute declarations
(attribute
  name: (identifier) @name) @definition.attribute
 
; Generic type parameters
(type_parameter
  name: (identifier) @name) @definition.type_parameter
 
; LINQ expressions
(query_expression) @definition.linq_expression
`

export const rubyQuery = `
; Method definitions
(method
  name: (identifier) @name.definition.method) @definition.method

; Singleton methods
(singleton_method
  object: (_)
  name: (identifier) @name.definition.method) @definition.method

; Method aliases
(alias
  name: (_) @name.definition.method) @definition.method

; Class definitions
(class
  name: [
    (constant) @name.definition.class
    (scope_resolution
      name: (_) @name.definition.class)
  ]) @definition.class

; Singleton classes
(singleton_class
  value: [
    (constant) @name.definition.class
    (scope_resolution
      name: (_) @name.definition.class)
  ]) @definition.class

; Module definitions
(module
  name: [
    (constant) @name.definition.module
    (scope_resolution
      name: (_) @name.definition.module)
  ]) @definition.module

; Constants
(assignment
  left: (constant) @name.definition.constant) @definition.constant

; Global variables
(global_variable) @definition.global_variable

; Instance variables
(instance_variable) @definition.instance_variable

; Class variables
(class_variable) @definition.class_variable

; Symbols
(simple_symbol) @definition.symbol
(hash_key_symbol) @definition.symbol

; Blocks
(block) @definition.block
(do_block) @definition.block

; Basic mixin statements - capture all include/extend/prepend calls
(call
  method: (identifier) @_mixin_method
  arguments: (argument_list
    (constant) @name.definition.mixin)
  (#match? @_mixin_method "^(include|extend|prepend)$")) @definition.mixin

; Mixin module definition
(module
  name: (constant) @name.definition.mixin_module
  (#match? @name.definition.mixin_module ".*Module$")) @definition.mixin_module

; Mixin-related methods
(method
  name: (identifier) @name.definition.mixin_method
  (#match? @name.definition.mixin_method "(included|extended|prepended)_method")) @definition.mixin_method

; Singleton class blocks
(singleton_class) @definition.singleton_class

; Class methods in singleton context
(singleton_method
  object: (self)
  name: (identifier) @name.definition.singleton_method) @definition.singleton_method

; Attribute accessors
(call
  method: (identifier) @_attr_accessor
  arguments: (argument_list
    (_) @name.definition.attr_accessor)
  (#eq? @_attr_accessor "attr_accessor")) @definition.attr_accessor

(call
  method: (identifier) @_attr_reader
  arguments: (argument_list
    (_) @name.definition.attr_reader)
  (#eq? @_attr_reader "attr_reader")) @definition.attr_reader

(call
  method: (identifier) @_attr_writer
  arguments: (argument_list
    (_) @name.definition.attr_writer)
  (#eq? @_attr_writer "attr_writer")) @definition.attr_writer

; Class macros (Rails-like)
(call
  method: (identifier) @_macro_name
  arguments: (argument_list
    (_) @name.definition.class_macro)
  (#match? @_macro_name "^(has_many|belongs_to|has_one|validates|scope|before_action|after_action)$")) @definition.class_macro

; Exception handling
(begin) @definition.begin
(rescue) @definition.rescue
(ensure) @definition.ensure

; Keyword arguments
(keyword_parameter
  name: (identifier) @name.definition.keyword_parameter) @definition.keyword_parameter

; Splat operators
(splat_parameter) @definition.splat_parameter
(splat_argument) @definition.splat_argument

; Hash syntax variants
(pair
  key: (_) @name.definition.hash_key) @definition.hash_pair

; String interpolation - capture the string with interpolation and surrounding context
(assignment
  left: (identifier) @name.definition.string_var
  right: (string
    (interpolation))) @definition.string_interpolation

; Regular expressions - capture the regex pattern and assignment
(assignment
  left: (identifier) @name.definition.regex_var
  right: (regex)) @definition.regex_assignment

; Pattern matching - capture the entire case_match structure
(case_match) @definition.case_match

; Pattern matching - capture in_clause with hash pattern
(in_clause
  pattern: (hash_pattern)) @definition.hash_pattern_clause

; Endless methods - capture the method definition with name and surrounding context
(comment) @_endless_method_comment
(#match? @_endless_method_comment "Ruby 3.0\\+ endless method")
(method
  name: (identifier) @name.definition.endless_method
  body: (binary
    operator: "=")) @definition.endless_method

; Pin operator - capture the entire in_clause with variable_reference_pattern
(in_clause
  pattern: (variable_reference_pattern)) @definition.pin_pattern_clause

; Shorthand hash syntax - capture the method containing shorthand hash
(comment) @_shorthand_hash_comment
(#match? @_shorthand_hash_comment "Ruby 3.1\\+ shorthand hash syntax")
(method
  name: (identifier) @name.definition.shorthand_method) @definition.shorthand_method

; Shorthand hash syntax - capture the hash with shorthand syntax
(hash
  (pair
    (hash_key_symbol)
    ":")) @definition.shorthand_hash

; Capture larger contexts for features that need at least 4 lines

; Capture the entire program to include all comments and code
(program) @definition.program

; Capture all comments
(comment) @definition.comment

; Capture all method definitions
(method) @definition.method_all
`

export const javaQuery = `
; Module declarations
(module_declaration
  name: (scoped_identifier) @name.definition.module) @definition.module

; Package declarations
((package_declaration
  (scoped_identifier)) @name.definition.package) @definition.package

; Line comments
(line_comment) @definition.comment

; Class declarations
(class_declaration
  name: (identifier) @name.definition.class) @definition.class

; Interface declarations
(interface_declaration
  name: (identifier) @name.definition.interface) @definition.interface

; Enum declarations
(enum_declaration
  name: (identifier) @name.definition.enum) @definition.enum

; Record declarations
(record_declaration
  name: (identifier) @name.definition.record) @definition.record

; Annotation declarations
(annotation_type_declaration
  name: (identifier) @name.definition.annotation) @definition.annotation

; Constructor declarations
(constructor_declaration
  name: (identifier) @name.definition.constructor) @definition.constructor

; Method declarations
(method_declaration
  type: (_) @definition.method.start ; kilocode_change
  name: (identifier) @name.definition.method) @definition.method

; Inner class declarations
(class_declaration
  (class_body
    (class_declaration
      name: (identifier) @name.definition.inner_class))) @definition.inner_class

; Static nested class declarations
(class_declaration
  (class_body
    (class_declaration
      name: (identifier) @name.definition.static_nested_class))) @definition.static_nested_class

; Lambda expressions
(lambda_expression) @definition.lambda

; Field declarations
(field_declaration
  (modifiers)?
  type: (_)
  declarator: (variable_declarator
    name: (identifier) @name.definition.field)) @definition.field

; Import declarations
(import_declaration
  (scoped_identifier) @name.definition.import) @definition.import

; Type parameters
(type_parameters
  (type_parameter) @name.definition.type_parameter) @definition.type_parameter
`

export const phpQuery = `
;--------------------------
; 1. CLASS DEFINITIONS
;--------------------------
; Regular classes
(class_declaration
  name: (name) @name.definition.class) @definition.class

; Abstract classes
(class_declaration
  (abstract_modifier)
  name: (name) @name.definition.abstract_class) @definition.abstract_class

; Final classes
(class_declaration
  (final_modifier)
  name: (name) @name.definition.final_class) @definition.final_class

; Readonly classes (PHP 8.2+)
(class_declaration
  (readonly_modifier)
  name: (name) @name.definition.readonly_class) @definition.readonly_class

;--------------------------
; 2. INTERFACE & TRAIT DEFINITIONS
;--------------------------
; Interfaces
(interface_declaration
  name: (name) @name.definition.interface) @definition.interface

; Traits
(trait_declaration
  name: (name) @name.definition.trait) @definition.trait

; Enums (PHP 8.1+)
(enum_declaration
  name: (name) @name.definition.enum) @definition.enum

;--------------------------
; 3. FUNCTION & METHOD DEFINITIONS
;--------------------------
; Global functions
(function_definition
  name: (name) @name.definition.function) @definition.function

; Regular methods
(method_declaration
  name: (name) @name.definition.method) @definition.method

; Static methods
(method_declaration
  (static_modifier)
  name: (name) @name.definition.static_method) @definition.static_method

; Abstract methods
(method_declaration
  (abstract_modifier)
  name: (name) @name.definition.abstract_method) @definition.abstract_method

; Final methods
(method_declaration
  (final_modifier)
  name: (name) @name.definition.final_method) @definition.final_method

; Arrow functions (PHP 7.4+)
(arrow_function) @definition.arrow_function

;--------------------------
; 4. PROPERTY DEFINITIONS
;--------------------------
; Regular properties
(property_declaration
  (property_element
    (variable_name
      (name) @name.definition.property))) @definition.property

; Static properties
(property_declaration
  (static_modifier)
  (property_element
    (variable_name
      (name) @name.definition.static_property))) @definition.static_property

; Readonly properties (PHP 8.1+)
(property_declaration
  (readonly_modifier)
  (property_element
    (variable_name
      (name) @name.definition.readonly_property))) @definition.readonly_property

; Constructor property promotion (PHP 8.0+)
(property_promotion_parameter
  name: (variable_name
    (name) @name.definition.promoted_property)) @definition.promoted_property

;--------------------------
; 5. OTHER LANGUAGE CONSTRUCTS
;--------------------------
; Constants
(const_declaration
  (const_element
    (name) @name.definition.constant)) @definition.constant

; Namespaces
(namespace_definition
  name: (namespace_name) @name.definition.namespace) @definition.namespace

; Use statements (imports)
(namespace_use_declaration
  (namespace_use_clause
    (qualified_name) @name.definition.use)) @definition.use

; Anonymous classes
(object_creation_expression
  (declaration_list)) @definition.anonymous_class

; Attributes (PHP 8.0+)
(attribute_group
  (attribute
    (name) @name.definition.attribute)) @definition.attribute

; Match expressions (PHP 8.0+)
(match_expression) @definition.match_expression

; Heredoc syntax
(heredoc) @definition.heredoc

; Nowdoc syntax
(nowdoc) @definition.nowdoc
`

export const htmlQuery = `
; Document structure
(document) @definition.document

; Elements with content
(element
  (start_tag
    (tag_name) @name.definition)
  (#not-eq? @name.definition "script")
  (#not-eq? @name.definition "style")) @definition.element

; Script elements
(script_element
  (start_tag
    (tag_name) @name.definition)) @definition.script

; Style elements
(style_element
  (start_tag
    (tag_name) @name.definition)) @definition.style

; Attributes
(attribute
  (attribute_name) @name.definition) @definition.attribute

; Comments
(comment) @definition.comment

; Text content
(text) @definition.text

; Raw text content
(raw_text) @definition.raw_text

; Void elements (self-closing)
(element
  (start_tag
    (tag_name) @name.definition)
  (#match? @name.definition "^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$")) @definition.void_element

; Self-closing tags
(self_closing_tag
  (tag_name) @name.definition) @definition.self_closing_tag

; Doctype declarations
(doctype) @definition.doctype

; Multiple elements (parent with children)
(element
  (element)+) @definition.nested_elements
`

export const swiftQuery = `
; Class declarations - captures standard, final, and open classes
(class_declaration
  name: (type_identifier) @name) @definition.class

; Protocol declarations - captures protocols with requirements
(protocol_declaration
  name: (type_identifier) @name) @definition.interface

; Method declarations in classes/structs/enums/extensions
(function_declaration
  name: (simple_identifier) @name) @definition.method

; Static/class method declarations
(function_declaration
  (modifiers
    (property_modifier))
  name: (simple_identifier) @name) @definition.static_method

; Initializers - captures designated initializers
(init_declaration
  "init" @name) @definition.initializer

; Convenience initializers
(init_declaration
  (modifiers (member_modifier))
  "init" @name) @definition.convenience_initializer

; Deinitializers
(deinit_declaration
  "deinit" @name) @definition.deinitializer

; Subscript declarations
(subscript_declaration
  (parameter) @name) @definition.subscript

; Property declarations - captures stored properties
(property_declaration
  (pattern) @name) @definition.property

; Computed property declarations with accessors
(property_declaration
  (pattern)
  (computed_property)) @definition.computed_property

; Type aliases
(typealias_declaration
  name: (type_identifier) @name) @definition.type_alias

; Protocol property requirements
(protocol_property_declaration
  name: (pattern) @name) @definition.protocol_property

; Protocol method requirements
(protocol_function_declaration
  name: (simple_identifier) @name) @definition.protocol_method
`

export const kotlinQuery = `
; Type alias declarations
(type_alias
  (type_identifier) @name.definition.type_alias
) @definition.type_alias

; Regular class declarations
(class_declaration
  (type_identifier) @name.definition.class
) @definition.class

; Data class declarations
(class_declaration
  (modifiers
    (class_modifier) @_modifier (#eq? @_modifier "data"))
  (type_identifier) @name.definition.data_class
) @definition.data_class

; Abstract class declarations
(class_declaration
  (modifiers
    (inheritance_modifier) @_modifier (#eq? @_modifier "abstract"))
  (type_identifier) @name.definition.abstract_class
) @definition.abstract_class

; Sealed class declarations
(class_declaration
  (modifiers
    (class_modifier) @_modifier (#eq? @_modifier "sealed"))
  (type_identifier) @name.definition.sealed_class
) @definition.sealed_class

; Enum class declarations
(class_declaration
  (type_identifier)
  (enum_class_body)
) @definition.enum_class

; Interface declarations
(class_declaration
  (type_identifier) @name.definition.interface
) @definition.interface

; Regular function declarations
(function_declaration
  (simple_identifier) @name.definition.function
) @definition.function


; Suspend function declarations
(function_declaration
  (modifiers
    (function_modifier) @_modifier (#eq? @_modifier "suspend"))
  (simple_identifier) @name.definition.suspend_function
) @definition.suspend_function

; Object declarations
(object_declaration
  (type_identifier) @name.definition.object
) @definition.object

; Companion object declarations
(companion_object) @definition.companion_object



; Annotation class declarations
(class_declaration
  (modifiers
    (class_modifier) @_modifier (#eq? @_modifier "annotation"))
  (type_identifier) @name.definition.annotation_class
) @definition.annotation_class
; Extension function declarations
(function_declaration
  (modifiers
    (function_modifier) @_modifier (#eq? @_modifier "extension"))
  (simple_identifier) @name.definition.extension_function
) @definition.extension_function

; Primary constructor declarations
(class_declaration
  (primary_constructor) @definition.primary_constructor
)

; Secondary constructor declarations
(secondary_constructor) @definition.secondary_constructor

; Property declarations
(property_declaration
  (variable_declaration
    (simple_identifier) @name.definition.property)
) @definition.property

; Property declarations with accessors
(property_declaration
  (variable_declaration
    (simple_identifier) @name.definition.property)
  (getter)? @definition.getter
  (setter)? @definition.setter
) @definition.property_with_accessors

`

export const cssQuery = `
; CSS rulesets and selectors
(rule_set
  (selectors
    (class_selector
      (class_name) @name.definition.ruleset)) @_rule
  (#match? @name.definition.ruleset "test-ruleset-definition"))

(rule_set
  (selectors
    (pseudo_class_selector
      (class_selector
        (class_name) @name.definition.selector))) @_selector
  (#match? @name.definition.selector "test-selector-definition"))

; Media queries
(media_statement
  (block
    (rule_set
      (selectors
        (class_selector
          (class_name) @name.definition.media_query)))) @_media
  (#match? @name.definition.media_query "test-media-query-definition-container"))

; Keyframe animations
(keyframes_statement
  (keyframes_name) @name.definition.keyframe) @_keyframe
  (#match? @name.definition.keyframe "test-keyframe-definition-fade")

; Animation related classes
(rule_set
  (selectors
    (class_selector
      (class_name) @name.definition.animation)) @_animation
  (#match? @name.definition.animation "test-animation-definition"))

; Functions
(rule_set
  (selectors
    (class_selector
      (class_name) @name.definition.function)) @_function
  (#match? @name.definition.function "test-function-definition"))

; Variables (CSS custom properties)
(declaration
  (property_name) @name.definition.variable) @_variable
  (#match? @name.definition.variable "^--test-variable-definition")

; Import statements
(import_statement
  (string_value) @name.definition.import) @_import
  (#match? @name.definition.import "test-import-definition")

; Nested rulesets
(rule_set
  (selectors
    (class_selector
      (class_name) @name.definition.nested_ruleset)) @_nested
  (#match? @name.definition.nested_ruleset "test-nested-ruleset-definition"))

; Mixins (using CSS custom properties as a proxy)
(rule_set
  (selectors
    (class_selector
      (class_name) @name.definition.mixin)) @_mixin
  (#match? @name.definition.mixin "test-mixin-definition"))`

export const ocamlQuery = `
; Captures module definitions
(module_definition
  (module_binding
    name: (module_name) @name.definition)) @definition.module

; Captures type definitions
(type_definition
  (type_binding
    name: (type_constructor) @name.definition)) @definition.type

; Captures function definitions
(value_definition
  (let_binding
    pattern: (value_name) @name.definition
    (parameter))) @definition.function

; Captures class definitions
(class_definition
  (class_binding
    name: (class_name) @name.definition)) @definition.class

; Captures method definitions
(method_definition
  name: (method_name) @name.definition) @definition.method

; Captures value bindings
(value_definition
  (let_binding
    pattern: (value_name) @name.definition)) @definition.value
`

export const solidityQuery = `
; Contract declarations
(contract_declaration
  name: (identifier) @name.definition.contract) @definition.contract

(interface_declaration
  name: (identifier) @name.definition.interface) @definition.interface

(library_declaration
  name: (identifier) @name.definition.library) @definition.library

; Function declarations
(function_definition
  name: (identifier) @name.definition.function) @definition.function

(modifier_definition
  name: (identifier) @name.definition.modifier) @definition.modifier

(constructor_definition) @definition.constructor

(fallback_receive_definition
  (visibility)
  (state_mutability)) @definition.fallback

; Type declarations
(struct_declaration
  name: (identifier) @name.definition.struct) @definition.struct

(enum_declaration
  name: (identifier) @name.definition.enum) @definition.enum

(event_definition
  name: (identifier) @name.definition.event) @definition.event

(error_declaration
  name: (identifier) @name.definition.error) @definition.error

; Variable declarations
(state_variable_declaration
  name: (identifier) @name.definition.variable) @definition.variable

; Using directives
(using_directive
  (type_alias) @name.definition.using) @definition.using`

export const tomlQuery = `
; Tables - capture the entire table node
(table) @definition

; Array tables - capture the entire array table node
(table_array_element) @definition

; Key-value pairs - capture the entire pair
(pair) @definition

; Arrays and inline tables
(array) @definition
(inline_table) @definition

; Basic values
(string) @definition
(integer) @definition
(float) @definition
(boolean) @definition
(offset_date_time) @definition
(local_date) @definition
(local_time) @definition
`

export const vueQuery = `
; Top-level structure
(component) @component.definition

; Template section
(template_element) @template.definition
(template_element
  (element
    (start_tag
      (tag_name) @element.name.definition))
  (element
    (start_tag
      (attribute
        (attribute_name) @attribute.name.definition)))
  (element
    (start_tag
      (directive_attribute
        (directive_name) @directive.name.definition))))

; Script section
(script_element) @script.definition
(script_element
  (raw_text) @script.content.definition)

; Style section
(style_element) @style.definition
(style_element
  (raw_text) @style.content.definition)
`

export const luaQuery = `
; Function definitions
(function_definition_statement
  name: (identifier) @name.definition.function) @definition.function

(function_definition_statement
  name: (variable
    table: (identifier)
    field: (identifier) @name.definition.method)) @definition.method

(local_function_definition_statement
  name: (identifier) @name.definition.function) @definition.function

; Table constructors (class-like structures)
(local_variable_declaration
  (variable_list
    (variable name: (identifier) @name.definition.table))
  (expression_list
    value: (table))) @definition.table

; Variable declarations
(variable_assignment
  (variable_list
    (variable name: (identifier) @name.definition.variable))) @definition.variable

; Local variable declarations
(local_variable_declaration
  (variable_list
    (variable name: (identifier) @name.definition.variable))) @definition.variable
`

export const systemrdlQuery = `
; Component declarations
(component_named_def
  type: (component_type)
  id: (id) @name.definition.component) @definition.component

; Field declarations
(component_anon_def
  type: (component_type (component_primary_type))
  body: (component_body
    (component_body_elem
      (property_assignment)))) @definition.field

; Property declarations
(property_definition
  (id) @name.definition.property) @definition.property

; Parameter declarations
(component_inst
  id: (id) @name.definition.parameter) @definition.parameter

; Enum declarations
(enum_def
  (id) @name.definition.enum) @definition.enum
`

export const tlaPlusQuery = `
; Module declarations
(module
  name: (identifier) @name.definition.module) @definition.module

; Operator definitions with optional parameters
(operator_definition
  name: (identifier) @name.definition.operator
  parameter: (identifier)?) @definition.operator

; Function definitions with bounds
(function_definition
  name: (identifier) @name.definition.function
  (quantifier_bound)?) @definition.function

; Variable declarations
(variable_declaration
  (identifier) @name.definition.variable) @definition.variable

; Constant declarations
(constant_declaration
  (identifier) @name.definition.constant) @definition.constant
`

export const zigQuery = `
; Functions
(function_declaration) @function.definition

; Structs and containers
(variable_declaration
  (identifier) @name
  (struct_declaration)
) @container.definition

; Enums
(variable_declaration
  (identifier) @name
  (enum_declaration)
) @container.definition

; Variables and constants
(variable_declaration
  (identifier) @name
) @variable.definition
`

export const embeddedTemplateQuery = `
; Code blocks - class, module, method definitions
(directive
  (code) @name.definition.code) @definition.directive

; Output blocks - expressions
(output_directive
  (code) @output.content) @output

; Comments - documentation and section markers
(comment_directive
  (comment) @name.definition.comment) @definition.comment
`

export const elispQuery = `
; Function definitions - capture only name and actual function node
((function_definition
  name: (symbol) @name.definition.function) @_func
  (#match? @name.definition.function "^[^;]"))

; Macro definitions - capture only name and actual macro node
((macro_definition
  name: (symbol) @name.definition.macro) @_macro
  (#match? @name.definition.macro "^[^;]"))

; Custom forms - match defcustom specifically and avoid comments
((list
  . (symbol) @_def
  . (symbol) @name.definition.custom) @_custom
  (#eq? @_def "defcustom")
  (#match? @name.definition.custom "^[^;]"))

; Face definitions - match defface specifically and avoid comments
((list
  . (symbol) @_def
  . (symbol) @name.definition.face) @_face
  (#eq? @_def "defface")
  (#match? @name.definition.face "^[^;]"))

; Group definitions - match defgroup specifically and avoid comments
((list
  . (symbol) @_def
  . (symbol) @name.definition.group) @_group
  (#eq? @_def "defgroup")
  (#match? @name.definition.group "^[^;]"))

; Advice definitions - match defadvice specifically and avoid comments
((list
  . (symbol) @_def
  . (symbol) @name.definition.advice) @_advice
  (#eq? @_def "defadvice")
  (#match? @name.definition.advice "^[^;]"))
`

export const elixirQuery = `
; Module, Protocol, and Implementation definitions
(call
  target: (identifier) @function
  (arguments) @args
  (do_block)?
  (#match? @function "^(defmodule|defprotocol|defimpl)$")) @definition.module

; Function definitions
(call
  target: (identifier) @function
  (arguments) @args
  (do_block)?
  (#eq? @function "def")) @definition.function

; Macro definitions
(call
  target: (identifier) @function
  (arguments) @args
  (do_block)?
  (#eq? @function "defmacro")) @definition.macro

; Struct definitions
(call
  target: (identifier) @function
  (arguments (list))
  (#eq? @function "defstruct")) @definition.struct

; Guard definitions
(call
  target: (identifier) @function
  (arguments) @args
  (#eq? @function "defguard")) @definition.guard

; Behaviour callback definitions
(call
  target: (identifier) @function
  (arguments) @args
  (#eq? @function "@callback")) @definition.behaviour

; Sigils
(sigil
  (sigil_name)
  (quoted_content)) @definition.sigil

; Module attributes
(unary_operator
  operator: "@"
  operand: (call)) @definition.attribute

; Test definitions with string name and map args
(call
  target: (identifier) @function
  (arguments
    (string)
    (map))
  (#eq? @function "test")) @definition.test

; Pipeline operator usage
(binary_operator
  operator: "|>"
  left: (_) @left
  right: (_) @right) @definition.pipeline

; For comprehensions with generator and filter clauses
(call
  target: (identifier) @function
  (arguments) @args
  (do_block)?
  (#eq? @function "for")) @definition.for_comprehension`

export const scalaQuery = `
; Classes
(class_definition
  name: (identifier) @name.definition) @definition.class

(class_definition
  (modifiers)
  name: (identifier) @name.definition) @definition.class

; Objects
(object_definition
  name: (identifier) @name.definition) @definition.object

(object_definition
  name: (identifier) @name.definition
  extend: (extends_clause)?) @definition.object

; Traits
(trait_definition
  name: (identifier) @name.definition) @definition.trait

; Methods
(function_definition
  name: (identifier) @name.definition) @definition.method

; Values and Variables
(val_definition
  pattern: (identifier) @name.definition) @definition.variable

(var_definition
  pattern: (identifier) @name.definition) @definition.variable

(val_definition
  (modifiers)
  pattern: (identifier) @name.definition) @definition.variable

; Types
(type_definition
  name: (type_identifier) @name.definition) @definition.type

; Package declarations
(package_clause
  name: (package_identifier) @name.definition) @definition.namespace
`

