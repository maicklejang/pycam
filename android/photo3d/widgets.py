"""
Copyright 2026 PyCAM contributors

This file is part of PyCAM.

PyCAM is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

PyCAM is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with PyCAM.  If not, see <http://www.gnu.org/licenses/>.


A few small building blocks for the user interface of the scanner application.
"""

from kivy.metrics import dp, sp
from kivy.uix.boxlayout import BoxLayout
from kivy.uix.button import Button
from kivy.uix.label import Label
from kivy.uix.popup import Popup
from kivy.uix.scrollview import ScrollView
from kivy.uix.textinput import TextInput

BACKGROUND = (0.11, 0.12, 0.14, 1)
SURFACE = (0.17, 0.18, 0.21, 1)
ACCENT = (0.20, 0.46, 0.72, 1)
ACCENT_STRONG = (0.16, 0.58, 0.40, 1)
MUTED = (0.62, 0.65, 0.70, 1)
WARNING = (0.75, 0.42, 0.25, 1)


def title_label(text, **kwargs):
    kwargs.setdefault("font_size", sp(22))
    kwargs.setdefault("bold", True)
    kwargs.setdefault("size_hint_y", None)
    kwargs.setdefault("height", dp(40))
    return Label(text=text, **kwargs)


def body_label(text, **kwargs):
    kwargs.setdefault("font_size", sp(14))
    kwargs.setdefault("color", MUTED)
    kwargs.setdefault("halign", "left")
    kwargs.setdefault("valign", "top")
    label = Label(text=text, **kwargs)
    label.bind(size=lambda widget, value: setattr(widget, "text_size", value))
    return label


def action_button(text, callback, primary=False, **kwargs):
    kwargs.setdefault("size_hint_y", None)
    kwargs.setdefault("height", dp(52))
    kwargs.setdefault("font_size", sp(16))
    kwargs.setdefault("background_normal", "")
    kwargs.setdefault("background_color", ACCENT_STRONG if primary else SURFACE)
    button = Button(text=text, **kwargs)
    button.bind(on_release=lambda widget: callback())
    return button


class LabeledInput(BoxLayout):
    """ a text field with a caption and a unit """

    def __init__(self, caption, value, unit="mm", **kwargs):
        super().__init__(orientation="horizontal", size_hint_y=None, height=dp(44),
                         spacing=dp(6), **kwargs)
        self.add_widget(Label(text=caption, font_size=sp(14), halign="left",
                              size_hint_x=0.55))
        self.input = TextInput(text=str(value), multiline=False, input_filter="float",
                               font_size=sp(16), size_hint_x=0.3, padding=(dp(8), dp(10)))
        self.add_widget(self.input)
        self.add_widget(Label(text=unit, font_size=sp(13), color=MUTED, size_hint_x=0.15))

    @property
    def value(self):
        try:
            return float(self.input.text)
        except ValueError:
            return None


def show_message(title, message):
    """ show a simple dialog """
    content = BoxLayout(orientation="vertical", spacing=dp(10), padding=dp(12))
    scroll = ScrollView()
    label = body_label(message, size_hint_y=None)
    label.bind(texture_size=lambda widget, value: setattr(widget, "height", value[1]))
    scroll.add_widget(label)
    content.add_widget(scroll)
    popup = Popup(title=title, content=content, size_hint=(0.9, 0.7))
    content.add_widget(action_button("close", popup.dismiss))
    popup.open()
    return popup
