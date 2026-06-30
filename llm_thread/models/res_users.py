from odoo import models


class ResUsers(models.Model):
    _inherit = "res.users"

    def _init_messaging(self):
        """Extend messaging init (Odoo 17 signature: returns a dict, no Store).

        Odoo 18 passes a ``Store`` accumulator and the LLM threads are pushed
        via ``_thread_to_store``; that Store API does not exist in Odoo 17, so
        we simply return the base result here. LLM threads are loaded by the
        frontend store loaders instead.
        """
        return super()._init_messaging()
